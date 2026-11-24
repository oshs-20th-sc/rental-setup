const studentAuthDomain = "students.ohsung-rental.invalid";

export function isValidStudentId(studentId) {
  return typeof studentId === "string" && studentId.length === 7 && /^[0-9]{7}$/.test(studentId);
}

export function studentAuthEmail(studentId) {
  if (!isValidStudentId(studentId)) throw new Error("학생 ID를 숫자 7자리로 입력해 주세요.");
  return `${studentId}@${studentAuthDomain}`;
}

export function isStudentAuthEmail(email) {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(`@${studentAuthDomain}`);
}
