# rental-setup — 빌리러 오성 통합 운영 CLI v3.0.1

학교가 승인한 Firebase 운영 담당자를 위한 Windows / macOS용 독립형 관리자 패키지입니다. 웹사이트 소스, VS Code, Codex, 별도 백엔드 서버를 요구하지 않습니다. 기본 대상은 `ohsung-rental`입니다. 기존 운영 프로젝트에 배포나 쓰기를 수행하지 않고 제작했습니다.

관리 도구 저장소: https://github.com/oshs-20th-sc/rental-setup

## 1. 설치와 권한

- Node.js 24.x (24.22.3 이상, 25 미만; 웹 저장소의 기준 버전), npm, 인터넷 연결.
- `firebase-admin` 14.5.1 및 `firebase-tools` 15.37.0을 패키지 자체 의존성으로 설치합니다. Firebase CLI는 편의상 로그인 용도로 포함하며, 데이터/Rules 관리에는 Admin SDK, 인덱스/프로젝트 설정에는 공식 REST API를 이용합니다. 외부 Firebase CLI 전역 설치는 필요하지 않습니다.
- Firebase 프로젝트를 실제로 관리할 수 있는 학교에서 승인한 Google 계정 및 IAM 권한이 필요합니다. 웹 앱의 `roles/{uid}` 관리자 권한과 Google Cloud IAM 권한은 별개입니다. 학생용 또는 웹 관리자 계정만으로 운영 CLI를 사용할 수 없습니다.
- 필요한 작업별 최소 IAM 권한을 운영 책임자가 부여하세요. 예: Firebase Authentication Admin, Cloud Datastore User, Cloud Datastore Index Admin, Firebase Rules Admin 등. DB 생성/웹 앱 생성/인증 설정에는 별도의 해당 관리 권한 및 API 활성화가 필요할 수 있습니다. 정확한 권한은 오류 및 해당 공식 API 문서에서 확인하세요. 프로젝트 Owner를 무조건 부여하지 마십시오.

### Windows (PowerShell)

```powershell
Expand-Archive -LiteralPath "$HOME\Downloads\rental-setup.zip" -DestinationPath "$HOME\Downloads"
Set-Location -LiteralPath "$HOME\Downloads\rental-setup"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
npm.cmd run login
.\rental-setup.cmd help
.\rental-setup.cmd setup-status
```

`Bypass`는 해당 설치 프로세스에만 적용됩니다. 학교의 실행 정책이 차단하면 승인 절차를 따르세요. 초기 `npm install`은 lock 파일을 생성하므로 설치 후 `package-lock.json`을 보관하세요. 이후에는 `npm ci`를 사용합니다. Node/SDK 설치 또는 테스트에 실패하면 운영 작업을 시작하지 마십시오.

### macOS/Linux

```bash
unzip ~/Downloads/rental-setup.zip -d ~/Downloads
cd ~/Downloads/rental-setup
npm install
npm test
npm run login
node bin/rental-setup.cjs setup-status
```

이후 macOS/Linux에서는 아래 Windows 명령의 `.\rental-setup.cmd` 대신 `node bin/rental-setup.cjs`를 입력합니다. `npm link`를 사용해 `rental-setup` 명령을 등록하는 것도 가능합니다. 셸 특수문자가 포함된 인자는 Windows에서도 `node .\bin\rental-setup.cjs` 직접 실행을 권장합니다.

### 인증 방식

기본은 기존 Firebase CLI 로그인 토큰으로 임시 ADC 파일을 생성합니다. 토큰은 표시하지 않고 종료 시 임시 파일을 삭제합니다. 이 로그인 호환 계층은 고정된 Firebase CLI의 내부 모듈을 사용하기 때문에 버전을 임의로 올리지 마세요. 표준 ADC를 이미 설정했다면 `GOOGLE_APPLICATION_CREDENTIALS` 또는 `OHSUNG_USE_ADC=1`을 통해 이 호환 계층을 우회할 수 있습니다. 서비스 계정 키를 새로 발급할 필요는 없으며, 키나 개인 비밀번호를 저장소에 올리지 마세요.

관리 명령의 기본값은 조회/사전 검사입니다. `--apply`가 있는 경우에만 실제 변경하며, 대상 확인 문구를 대화형 터미널에서 직접 입력해야 합니다. 설치 후 `setup-status`와 `doctor`부터 실행하세요.

다른 Firebase 프로젝트를 관리할 때는 명령 맨 앞의 `--project` 또는 `OHSUNG_PROJECT` 환경변수를 사용합니다. 기본 프로젝트가 아닌 경우 개인 작업 파일도 별도 디렉터리에 저장합니다.

```powershell
.\rental-setup.cmd --project my-authorized-project setup-status
```

실제 운영에 앞서 반드시 학교에서 승인한 별도 테스트 프로젝트에서 검증하세요. 이 CLI는 에뮬레이터 환경변수가 설정되어 있을 때 운영 작업을 거부합니다.

## 2. Firebase 최초 설정

전제: Firebase 프로젝트가 존재하며 필요한 Google API 및 Firebase Authentication 제품이 활성화되어 있어야 합니다. **Spark 요금제를 유지하려면** 새 프로젝트의 Firebase Authentication 첫 활성화는 콘솔에서 수행하십시오. 공개 Identity Platform 초기화 API는 결제 활성 프로젝트만 지원하므로 이 패키지는 요금제 변경 또는 Identity Platform 업그레이드를 하지 않습니다. Firebase 프로젝트 생성, 최초 제품 활성화/필요 API 권한, Google Cloud IAM 부여는 운영 담당자가 필요에 따라 콘솔에서 수행합니다.

기본 Firestore가 없는 경우에만 다음 명령을 사용합니다. `asia-northeast3`는 예시이므로 조직의 정책과 실제 사용 위치를 먼저 확인하세요. 생성 후 위치 변경은 단순 설정 변경으로 처리할 수 없습니다. 이미 존재하면 변경하지 않습니다.

```powershell
.\rental-setup.cmd db-create --location asia-northeast3
.\rental-setup.cmd db-create --location asia-northeast3 --apply
```

생성 요청은 비동기이므로 완료 후 `setup-status`로 확인합니다. 웹 앱이 없는 경우:

```powershell
.\rental-setup.cmd web-apps
.\rental-setup.cmd web-app-create --name "빌리러 오성" --apply
.\rental-setup.cmd web-config
```

여러 웹 앱이 있으면 `web-config --app-id APP_ID`를 사용합니다. 웹 설정은 공개 Firebase 웹 SDK 설정 네 값만 표시합니다. Cloudflare Pages에 수동 등록합니다. 호스팅 계정 및 도메인 연결은 이 패키지가 변경하지 않습니다.

초기 설정 일괄 검사 및 적용:

```powershell
.\rental-setup.cmd setup-status
.\rental-setup.cmd setup --domain ohsung-rental-bbo.pages.dev
.\rental-setup.cmd setup --domain ohsung-rental-bbo.pages.dev --apply
.\rental-setup.cmd indexes-status
```

도메인은 실제 배포 호스트로 교체하세요. `setup`은 DB 종류, Auth 설정, 현재 Rules, 복합 인덱스, 재고 번호 상태를 읽어 검사한 뒤 적용 시 Rules, 누락된 인덱스, 물품 번호 예약 초기화, Auth 이메일/비밀번호 설정과 승인된 도메인 추가를 순서대로 실행합니다. **학생 등록이나 관리자 계정 발급은 자동 실행하지 않습니다.** 여러 Google API에 걸친 작업으로 전체 원자성을 보장하지 않으며 중단 시 상태를 검사하고 단계별로 재실행해야 합니다. 인덱스 생성 요청 성공과 READY는 다릅니다. 모든 필요한 인덱스가 READY가 된 후 사용하세요.

개별 실행:

| 명령 | 역할 |
|---|---|
| `setup-status` | 구성 전체 검사 |
| `auth-config [--domain HOST]` | 현재 이메일/비밀번호 설정 및 도메인 변경 예정 확인 |
| `auth-config --domain HOST --apply` | 이메일/비밀번호 활성화, 도메인 추가 (기존 도메인 보존) |
| `rules-status` | 적용 중인 Rules 이름 및 SHA-256 비교 |
| `rules-deploy --apply` | 포함된 Rules 적용, 기존 Rules 백업 |
| `rules-rollback --ruleset ID --apply` | 이전 Ruleset ID로 복원 (백업 파일의 name 참고) |
| `indexes-status` | 필요한 12개 복합 인덱스 상태 |
| `indexes-deploy --apply` | 누락 인덱스 생성 요청, 기존 인덱스 삭제 안 함 |
| `inventory-init --apply` | 물품 번호 예약과 누락 필드 검사/보완 및 준비 완료 마커 |
| `web-apps` / `web-config` | Firebase 웹 앱 확인 및 공개 웹 SDK 설정 출력 |

Rules 변경은 운영 사이트 권한에 직접 영향을 줍니다. 새 버전의 Rules는 실제 웹 프로젝트와 함께 테스트하고 사전 비교 후 승인하세요. `rules-deploy`는 기존 운영 Rules를 덮어쓰기 때문에 개인 폴더에 Ruleset ID와 소스를 백업합니다. 자동으로 기존 인덱스를 삭제하거나 단일 필드 설정을 덮어쓰지는 않습니다. 인덱스 정의의 `fieldOverrides`가 추가된 경우 이 버전은 적용을 거부합니다.

물품 번호 예약 마이그레이션은 저장소 원본 도구를 사용합니다. **기존 재고가 있는 운영 환경에서는 사이트 사용 및 다른 관리자 쓰기 작업을 중지한 점검 시간에 실행하세요.** `inventorySettings/v1`이 이미 ready이면 정합성 검사만 수행합니다.

## 3. 학생 계정 및 학년도 갱신

UTF-8 JSON 배열 (실제 학생 명단은 이 패키지 외부에 보관):

```json
[
  {"studentId":"2600001","name":"가상 학생 A","grade":1},
  {"studentId":"2500001","name":"가상 학생 B","grade":2}
]
```

7자리 입학 당시 학번은 문자열로 고정합니다. `grade`는 현재 학년의 정수 1~3이며 생략할 수 있습니다. 비밀번호·이메일을 명단에 포함할 필요가 없습니다. `register --roster`로 명시적으로 원하는 연도의 파일을 지정하세요.

```powershell
.\rental-setup.cmd register --roster "$HOME\Downloads\2026_students_revised.json"
.\rental-setup.cmd register --roster "$HOME\Downloads\2026_students_revised.json" --apply
```

신규 계정의 Firebase Auth UID와 Firestore users 문서 ID는 7자리 학번입니다. `student_id` 클레임과 내부 임시 이메일을 사용합니다. Auth `importUsers()`는 최대 1,000명씩 분할합니다. 모두 신규인 1,278명 명단은 1,000+278명입니다. 기존 계정과 이메일, 기존 해시 UID, 역할 문서를 검사하고 서버 요청에서 `allowOverwrite:false`, `sanityCheck:true`를 사용하도록 고정 SDK의 호환 어댑터를 적용합니다. 다른 버전에서는 어댑터가 실패하도록 설계했습니다. 이 내부 SDK 연결은 모의 테스트를 통과했지만 실제 서버 통합 검증 전까지 안전성을 단정할 수 없습니다. 모든 운영 작업은 한 담당자가 진행하고 동시에 다른 등록 도구를 실행하지 마십시오.

Auth Import는 개별 난수 비밀번호 및 개별 salt의 PBKDF2_SHA256(120,000회)로 수행합니다. 이는 기존 웹 저장소의 STANDARD_SCRYPT 구현과는 별도의 호환 구현입니다. Firestore 프로필은 배치 단위 트랜잭션으로 준비/확정합니다. 공통 초기 비밀번호로 발급한 계정은 비활성 상태로 남습니다. 재실행 시 같은 명단·동일 옵션·같은 발급 기록 파일을 사용합니다. 과거 웹 도구로 생성된 미완료 발급은 원래 도구로 복구하는 것이 원칙이며 이 패키지에서 자동 복구를 보장하지 않습니다. 완료 계정은 변경하지 않습니다.

| 명령 | 기능 |
|---|---|
| `list [--query 검색어] [--grade 1]` | 학생 조회 및 검색 |
| `show 학번` | 개별 계정 조회 |
| `register --roster JSON` | 일괄 신규 등록 |
| `add 학번 --name 이름 --grade 1` | 개별 신규 등록 |
| `edit 학번 --name 이름 --grade 2` | 이름·학년 변경 |
| `reset 학번` / `reset-all` | 개인별 임시 비밀번호 재발급 |
| `enable 학번` / `enable-all` | 기존 비밀번호 유지, 계정 활성화 |
| `disable 학번` / `disable-all` | 비활성화 및 갱신 토큰 폐기 |
| `delete 학번` / `delete-all` | Auth 삭제, 비활성 프로필 및 대여 이력 보존 |
| `purge 학번` / `purge-all` | Auth와 대여 이력이 모두 없는 보관 프로필 삭제 |
| `sync --roster JSON` | 기존 학생의 이름·학년 갱신 및 누락/신규 인원 표시 |
| `doctor` | Auth·프로필·관리 권한 정합성 확인 |
| `audit` / `private-path` | 작업 로그 및 개인 폴더 확인 |

변경 명령에는 `--apply`가 필요합니다. `sync`는 신입생 등록 및 졸업생 비활성화를 자동 수행하지 않습니다. 별도로 검토하고 실행하세요. 삭제는 미반납 또는 알 수 없는 대여 상태를 검사하며 관리자/불일치 계정은 제외합니다. 사용자 식별자 변경은 자동 지원하지 않습니다. 계정 삭제 후 재등록은 같은 UID와 과거 이력에 영향을 줄 수 있어 자동 복원하지 않습니다.

초기 비밀번호 지정 옵션은 기존 호환성을 위해 지원하지만, 전교생에게 공개된 동일 비밀번호를 사용하지 않는 것이 원칙입니다. 개별 비밀번호 재발급 후 학생 본인에게 안전하게 전달하세요. 생성된 비밀번호 기록은 시도 대상이므로 실제 성공 결과를 대조해야 합니다. 비밀번호를 조회하는 기능은 제공하지 않습니다. 개인 폴더의 발급 기록과 비밀번호 파일은 암호화된 백업 등 학교의 안전한 관리 정책에 따라 보관하고 필요 기간이 지나면 삭제하세요.

## 4. 웹 관리자 계정

`admins-list`는 Firestore 역할 문서를 확인합니다. `admin-add`는 학생 계정이 아닌 별도 관리자 Auth 계정을 신규 생성하여 개인별 임시 비밀번호를 발급하고 프로필과 역할을 기록한 뒤 활성화합니다. 기존 이메일 충돌 시 덮어쓰지 않습니다. `admin-grant`는 이메일 확인을 완료한 기존 활성 계정만 지원합니다. 마지막 관리자 역할 삭제는 차단합니다. `admin-revoke`는 웹 앱 관리자 역할을 회수하고 갱신 토큰을 폐기하며 Google Cloud IAM 권한은 변경하지 않습니다. 권한 부여 대상 이메일은 학교 담당자 확인 후 사용하십시오.

```powershell
.\rental-setup.cmd admins-list
.\rental-setup.cmd admin-add --email "admin@example.org" --name "가상 관리자" --apply
.\rental-setup.cmd admin-revoke --email "old-admin@example.org"
```

위 이메일은 가상 예시입니다. 실제로 쓰지 마세요. 관리자 발급이 중단되면 생성된 Auth 계정을 자동 탈취/재사용하지 않으므로 `admins-list`, Firebase Auth 상태, 개인 비밀번호 기록을 담당자가 대조해 복구해야 합니다.

## 5. 물품 운영

복합 인덱스는 조회 성능/쿼리에 필요한 Firestore 설정이고, `productNumbers`는 물품 번호 중복을 막는 애플리케이션 데이터입니다. 두 기능은 별개입니다. `inventory-init`이 완료된 후 물품을 추가합니다.

```powershell
.\rental-setup.cmd products-list
.\rental-setup.cmd products-add --category "우산" --name "우산" --number 1
.\rental-setup.cmd products-add --category "우산" --name "우산" --number 1 --apply
.\rental-setup.cmd products-edit --id PRODUCT_ID --name "새 이름" --apply
.\rental-setup.cmd products-disable --id PRODUCT_ID --apply
.\rental-setup.cmd products-enable --id PRODUCT_ID --apply
.\rental-setup.cmd rentals-summary
```

여러 물품을 추가할 경우 `products-import --file JSON [--apply]`. 예시 `products.example.json`을 참고합니다. 실제 물품 수/카테고리는 운영자가 정합니다. 같은 카테고리의 번호는 1~9999 정수이며 동일 번호·동일 정보는 건너뛰고 충돌은 오류 처리합니다. 제품 문서와 `productNumbers` 예약은 하나의 Firestore 트랜잭션으로 처리합니다. 대여 중인 물품의 메타데이터 변경을 제한하며 사용 중지는 가능합니다. 대여 기록을 유지하기 위해 물품 영구 삭제와 대여 상태 강제 변경은 제공하지 않습니다. 반납 승인 및 대여 처리 자체는 기존 웹 관리자 콘솔을 사용합니다.

## 6. 운영 안전 및 인수인계

- `private-path`는 Windows `%LOCALAPPDATA%\OhsungRental-private`, macOS/Linux `~/.ohsung-rental-private`를 기본으로 표시합니다. 다른 프로젝트는 별도 폴더를 사용합니다. 기존 감사 로그·잠금 파일 이름과 개인 폴더는 이전 버전과의 호환성을 위해 유지합니다.
- Windows ACL 검사 및 Unix 파일 모드 검사, 로컬 변경 작업 잠금, 감사 기록을 적용합니다. 로컬 잠금은 다른 PC를 잠그지 않습니다. 예기치 않게 종료돼 잠금 파일이 남은 경우 실행 중인 프로세스가 없음을 확인한 뒤 개인 폴더의 `.student-admin.lock`을 담당자가 제거하세요.
- `--apply`는 항상 대화형 승인 문구가 필요합니다. 관리자 도구는 Firestore Rules를 우회할 수 있는 IAM 권한을 사용하므로 학교가 승인한 운영 담당자만 실행하십시오.
- 학생 명단, 발급/초기화 기록, 관리자 인증 파일, 감사 로그 및 규칙 백업은 소스 ZIP, GitHub, Cloudflare 정적 산출물과 분리합니다. 이전 담당자의 계정 로그인은 로그아웃하고 IAM 권한을 회수합니다. 새 담당자에게는 개인 인증 파일 대신 자신의 승인된 계정을 사용하도록 안내합니다.
- 패키지 버전과 웹사이트 Rules 및 인덱스의 소스 버전을 함께 기록합니다. `config/`의 현재 파일은 웹 프로젝트와 동기화되어 있어야 합니다. 규칙이 변경되면 원본과 테스트를 확인하고 관리 패키지를 새 버전으로 배포하세요. 자동으로 GitHub 최신 Rules를 내려받아 적용하지 않습니다.
- 학생 계정과 물품/대여 기록의 보관·삭제 기간은 학교 정책에 따라 결정합니다. CLI는 DB 전체 삭제나 대여 기록 일괄 삭제를 지원하지 않습니다.

## 7. 검증 범위 및 참고

v3.0.1 명칭 통일 버전은 Node 22.16.0 환경에서 순수 Node 모의/단위 테스트 29개와 문법 검사를 수행했습니다. Windows 실기, Node 24.x 환경에서 실제 npm 설치/SDK 통합, Firebase Emulator 및 실제 Firebase API는 아직 검증하지 못했습니다. API 권한/요금제/쿼터, Node/SDK 버전, 운영 데이터에 따라 실패할 수 있습니다. 운영 전 테스트 프로젝트에서 초기화, Rules 배포, 인덱스 생성/READY, 가상 학생 일괄 발급/로그인, 물품 트랜잭션 및 계정 관리 동작을 직접 확인하세요. 테스트 과정에서 실제 운영 Firebase에 쓰기를 수행하지 않았습니다.

GitHub 출처: https://github.com/oshs-20th-sc/ohsung-rental (main). 아래 원본 파일은 Git blob SHA가 동일합니다.

- `config/firestore.rules`: `72ac784cf5be02a26b7d02c4b71a532af014bcd3`
- `config/firestore.indexes.json`: `33f0ee7f97a9ce9231b690c0073a0fe880fdc88d`
- `config/firebase.json`: `81ecce508472704fcf840559594055fc9ffc53a1`
- `lib/migrate-inventory.mjs`: `2f04f8a01bf980fc1eaf35d613cdf483bafab66a`
- `lib/studentIdentity.js`: `f265e4195e6514b802c34301d1b467f2e8c6c572`

공식 문서:
- https://firebase.google.com/docs/auth/admin/import-users
- https://firebase.google.com/docs/admin/setup
- https://firebase.google.com/docs/rules/manage-deploy
- https://cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.collectionGroups.indexes/create
- https://cloud.google.com/firestore/docs/reference/rest/v1/projects.databases/create
- https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects/updateConfig
- https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects.identityPlatform/initializeAuth
- https://firebase.google.com/docs/reference/firebase-management/rest/v1beta1/projects.webApps/getConfig
