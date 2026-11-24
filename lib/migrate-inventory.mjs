import { fileURLToPath } from "node:url";
import process from "node:process";
import { parseArgs } from "node:util";
import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";

const EMULATOR_PROJECT = "demo-ohsung-rental";
const PAGE_SIZE = 300;
const READ_CHUNK_SIZE = 100;
const BATCH_WRITE_LIMIT = 400;
const CATEGORY_SEPARATOR = "|";

export class InventoryMigrationError extends Error {}

function validCategory(value) {
  return typeof value === "string" &&
    value.length > 0 && value.length <= 80 &&
    value.trim() === value &&
    !value.includes("|") &&
    !value.includes("/") &&
    !hasAsciiControlCharacters(value);
}

function hasAsciiControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function productNumberKey(category, displayNo) {
  if (!validCategory(category) || !Number.isInteger(displayNo) || displayNo < 1 || displayNo > 9999) {
    throw new InventoryMigrationError("물품의 카테고리와 번호가 올바르지 않습니다.");
  }
  return `${category}${CATEGORY_SEPARATOR}${displayNo}`;
}

function validProductId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function hasExactFields(data, expected) {
  const keys = Object.keys(data).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function createMigrationPlan(productRows, reservationRows, rentalRows, settingsRow, userRows = []) {
  if (!Array.isArray(productRows) || !Array.isArray(reservationRows) || !Array.isArray(rentalRows)) {
    throw new InventoryMigrationError("Firestore 스냅샷 형식이 올바르지 않습니다.");
  }

  const productsByKey = new Map();
  const productsById = new Map();
  const enabledBackfills = [];
  const activeRentalOwners = new Map();
  const usersById = new Map(userRows.map((row) => [row.id, row]));

  for (const row of productRows) {
    if (!row || !validProductId(row.id) || productsById.has(row.id)) {
      throw new InventoryMigrationError("물품 문서 ID가 중복되었거나 새 규칙에서 허용되지 않습니다.");
    }
    const data = row.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new InventoryMigrationError("물품 문서 데이터가 올바르지 않습니다.");
    }

    const required = ["category", "name", "displayNo", "status", "activeRentalId"];
    const allowed = [...required, "isEnabled"];
    if (!required.every((field) => Object.hasOwn(data, field)) ||
        Object.keys(data).some((field) => !allowed.includes(field))) {
      throw new InventoryMigrationError("물품 문서의 필드 구성이 올바르지 않습니다.");
    }
    if (!validCategory(data.category) ||
        typeof data.name !== "string" || data.name.trim() !== data.name ||
        data.name.length < 1 || data.name.length > 80 ||
        hasAsciiControlCharacters(data.name) ||
        !Number.isInteger(data.displayNo) || data.displayNo < 1 || data.displayNo > 9999 ||
        !["available", "rented", "return_requested"].includes(data.status) ||
        (data.activeRentalId !== null && !validProductId(data.activeRentalId)) ||
        (Object.hasOwn(data, "isEnabled") && typeof data.isEnabled !== "boolean")) {
      throw new InventoryMigrationError("물품 문서에 새 보안 규칙을 만족하지 않는 값이 있습니다.");
    }

    const key = productNumberKey(data.category, data.displayNo);
    if (productsByKey.has(key)) {
      throw new InventoryMigrationError("같은 카테고리에 중복된 물품 번호가 있습니다.");
    }
    productsByKey.set(key, row);
    productsById.set(row.id, row);

    if (data.status === "available" && data.activeRentalId !== null) {
      throw new InventoryMigrationError("대여 가능 물품에 활성 대여 ID가 연결되어 있습니다.");
    }
    if (data.status !== "available" && data.activeRentalId === null) {
      throw new InventoryMigrationError("대여 중 물품에 활성 대여 ID가 없습니다.");
    }
    if (data.status !== "available") {
      const owner = activeRentalOwners.get(data.activeRentalId);
      if (owner) throw new InventoryMigrationError("하나의 대여 기록이 여러 물품을 참조합니다.");
      activeRentalOwners.set(data.activeRentalId, row.id);
    }
    if (!Object.hasOwn(data, "isEnabled")) enabledBackfills.push(row.id);
  }

  const rentalsById = new Map();
  for (const row of rentalRows) {
    if (!row || !validProductId(row.id) || rentalsById.has(row.id) || !row.data ||
        typeof row.data !== "object" || Array.isArray(row.data)) {
      throw new InventoryMigrationError("대여 기록 참조가 올바르지 않습니다.");
    }
    rentalsById.set(row.id, row);
  }

  const borrowerNameBackfills = [];
  for (const [rentalId, productId] of activeRentalOwners) {
    const product = productsById.get(productId);
    const rental = rentalsById.get(rentalId);
    const expectedStatus = product.data.status;
    if (!rental || rental.data.productId !== productId || rental.data.status !== expectedStatus) {
      throw new InventoryMigrationError("활성 물품과 대여 기록의 연결 또는 상태가 일치하지 않습니다.");
    }
    if (Object.hasOwn(rental.data, "borrowerName")) {
      if (typeof rental.data.borrowerName !== "string" ||
          rental.data.borrowerName.trim() !== rental.data.borrowerName ||
          rental.data.borrowerName.length < 1 ||
          rental.data.borrowerName.length > 80 ||
          hasAsciiControlCharacters(rental.data.borrowerName)) {
        throw new InventoryMigrationError("활성 대여 기록의 학생 표시 이름이 올바르지 않습니다.");
      }
    } else if (validProductId(rental.data.userId)) {
      const user = usersById.get(rental.data.userId);
      const name = user?.data?.name;
      if (typeof name === "string" && name.trim() === name && name.length > 0 &&
          name.length <= 80 && !hasAsciiControlCharacters(name)) {
        borrowerNameBackfills.push({ rentalId, name });
      }
    }
  }

  for (const row of reservationRows) {
    if (!row || typeof row.id !== "string" || !row.data ||
        !hasExactFields(row.data, ["productId"]) || !validProductId(row.data.productId)) {
      throw new InventoryMigrationError("번호 예약 문서 형식이 올바르지 않습니다.");
    }
    const product = productsByKey.get(row.id);
    if (!product || product.id !== row.data.productId) {
      throw new InventoryMigrationError("기존 번호 예약 문서가 물품과 일치하지 않습니다.");
    }
  }

  const reservationsByKey = new Map(reservationRows.map((row) => [row.id, row]));
  const newReservations = [];
  for (const [key, product] of productsByKey) {
    const existing = reservationsByKey.get(key);
    if (existing) {
      if (existing.data.productId !== product.id) {
        throw new InventoryMigrationError("물품 번호 예약이 다른 물품에 연결되어 있습니다.");
      }
    } else {
      newReservations.push({ key, productId: product.id });
    }
  }

  if (settingsRow !== null && (
    !settingsRow.data ||
    !hasExactFields(settingsRow.data, ["ready"]) ||
    typeof settingsRow.data.ready !== "boolean"
  )) {
    throw new InventoryMigrationError("재고 초기화 상태 문서 형식이 올바르지 않습니다.");
  }

  const ready = settingsRow?.data.ready === true;
  if (ready && (newReservations.length > 0 || enabledBackfills.length > 0 || borrowerNameBackfills.length > 0)) {
    throw new InventoryMigrationError("초기화 완료 표시와 물품 인덱스 사이에 불일치가 있습니다.");
  }

  return {
    totalProducts: productRows.length,
    totalReservations: reservationRows.length,
    enabledBackfills: ready ? [] : enabledBackfills,
    borrowerNameBackfills: ready ? [] : borrowerNameBackfills,
    newReservations: ready ? [] : newReservations,
    alreadyReady: ready,
  };
}

async function listCollection(db, name) {
  const rows = [];
  let cursor = null;
  while (true) {
    let query = db.collection(name).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    rows.push(...page.docs.map((snapshot) => ({ id: snapshot.id, data: snapshot.data() })));
    if (page.size < PAGE_SIZE) return rows;
    cursor = page.docs.at(-1);
  }
}

async function readActiveRentals(db, productRows) {
  const activeIds = [...new Set(productRows
    .filter(({ data }) => data.status !== "available" && validProductId(data.activeRentalId))
    .map(({ data }) => data.activeRentalId))];
  const rentals = [];
  for (let start = 0; start < activeIds.length; start += READ_CHUNK_SIZE) {
    const ids = activeIds.slice(start, start + READ_CHUNK_SIZE);
    const refs = ids.map((id) => db.doc(`rentals/${id}`));
    const snapshots = await db.getAll(...refs);
    for (const snapshot of snapshots) {
      if (snapshot.exists) rentals.push({ id: snapshot.id, data: snapshot.data() });
    }
  }
  return rentals;
}

export async function inspectInventory(db) {
  const [productRows, reservationRows, settingsSnapshot] = await Promise.all([
    listCollection(db, "products"),
    listCollection(db, "productNumbers"),
    db.doc("inventorySettings/v1").get(),
  ]);
  const rentalRows = await readActiveRentals(db, productRows);
  const userIds = [...new Set(rentalRows
    .map(({ data }) => data.userId)
    .filter((uid) => validProductId(uid)))];
  const userRows = [];
  for (let start = 0; start < userIds.length; start += READ_CHUNK_SIZE) {
    const ids = userIds.slice(start, start + READ_CHUNK_SIZE);
    const refs = ids.map((uid) => db.doc(`users/${uid}`));
    const snapshots = await db.getAll(...refs);
    for (const snapshot of snapshots) {
      if (snapshot.exists) userRows.push({ id: snapshot.id, data: snapshot.data() });
    }
  }
  const settingsRow = settingsSnapshot.exists
    ? { id: settingsSnapshot.id, data: settingsSnapshot.data() }
    : null;
  return createMigrationPlan(productRows, reservationRows, rentalRows, settingsRow, userRows);
}

async function writeInventoryPlan(db, plan) {
  if (plan.alreadyReady) return false;

  const actions = [
    ...plan.newReservations.map(({ key, productId }) => ({
      type: "reservation",
      ref: db.doc(`productNumbers/${key}`),
      data: { productId },
    })),
    ...plan.enabledBackfills.map((productId) => ({
      type: "product-field",
      ref: db.doc(`products/${productId}`),
      data: { isEnabled: true },
    })),
    ...plan.borrowerNameBackfills.map(({ rentalId, name }) => ({
      type: "rental-field",
      ref: db.doc(`rentals/${rentalId}`),
      data: { borrowerName: name },
    })),
  ];

  for (let start = 0; start < actions.length; start += BATCH_WRITE_LIMIT) {
    const batch = db.batch();
    const group = actions.slice(start, start + BATCH_WRITE_LIMIT);
    for (const action of group) {
      if (action.type === "reservation") batch.create(action.ref, action.data);
      else batch.update(action.ref, action.data);
    }
    await batch.commit();
  }

  await db.runTransaction(async (transaction) => {
    const markerRef = db.doc("inventorySettings/v1");
    const marker = await transaction.get(markerRef);
    if (marker.exists && marker.get("ready") === true) return;
    transaction.set(markerRef, { ready: true });
  });
  return true;
}

function readOptions(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        apply: { type: "boolean" },
        emulator: { type: "boolean" },
        project: { type: "string" },
      },
    });
  } catch {
    throw new InventoryMigrationError("옵션을 확인해 주세요. --project PROJECT 또는 --emulator를 사용하세요.");
  }

  const { apply, emulator, project } = args.values;
  if (Number(Boolean(emulator)) + Number(project !== undefined) !== 1) {
    throw new InventoryMigrationError("--project PROJECT 또는 --emulator 하나를 지정하세요.");
  }
  if (project !== undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new InventoryMigrationError("Firebase 프로젝트 ID 형식이 올바르지 않습니다.");
  }
  if (!emulator && (
    project.startsWith("demo-") ||
    process.env.FIRESTORE_EMULATOR_HOST !== undefined ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== undefined
  )) {
    throw new InventoryMigrationError("운영 프로젝트 스캔에 Emulator 설정이 감지되었습니다.");
  }

  return { apply, emulator, project: emulator ? EMULATOR_PROJECT : project };
}

export async function migrateInventory(db, { apply = false } = {}) {
  const plan = await inspectInventory(db);
  if (apply && !plan.alreadyReady) await writeInventoryPlan(db, plan);
  return {
    ...plan,
    applied: apply && !plan.alreadyReady,
  };
}

async function main() {
  const options = readOptions();
  if (options.emulator) {
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    process.env.METADATA_SERVER_DETECTION = "none";
  }
  const app = initializeApp(options.emulator
    ? { projectId: EMULATOR_PROJECT }
    : { projectId: options.project, credential: applicationDefault() });

  try {
    const result = await migrateInventory(getFirestore(app), { apply: options.apply });
    console.log(result.alreadyReady
      ? `초기화가 완료된 재고를 검증했습니다. 물품 ${result.totalProducts}개 · 번호 예약 ${result.totalReservations}개`
      : `재고를 검사했습니다. 물품 ${result.totalProducts}개 · 번호 예약 추가 ${result.newReservations.length}개 · 사용 가능 필드 보완 ${result.enabledBackfills.length}개 · 학생 이름 보완 ${result.borrowerNameBackfills.length}개 · ${options.apply ? "적용 완료" : "쓰기 전 미리보기"}`);
    if (options.apply && !result.alreadyReady) console.log("inventorySettings/v1에 준비 완료를 기록했습니다.");
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof InventoryMigrationError
      ? error.message
      : "재고 확인에 실패했습니다. Firebase 권한과 데이터 참조를 점검한 뒤 다시 실행해 주세요.");
    process.exitCode = 1;
  }
}
