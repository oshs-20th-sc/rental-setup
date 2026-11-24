# 명령어와 운영 복구

모든 운영 예시는 앞에 `--project PROJECT_ID`를 붙여 사용합니다. 인증·권한·설치 방법은 [README](../README.md)를 참고하세요. PowerShell에서는 `rental-setup`을 `.\rental-setup.cmd`로 바꿉니다.

## 적용 순서와 권한

- 조회 명령에는 `--apply`가 없습니다. 변경 명령은 생략 시 사전 검사이며, `--apply`와 터미널의 확인 문구가 모두 있어야 실제로 변경합니다. 대부분의 변경 명령에서는 `--check`로 사전 검사 모드를 명시할 수도 있습니다.
- Google Cloud IAM 권한은 담당 업무에 따라 나눕니다. **Auth**는 Firebase Authentication 관리, **데이터**는 Cloud Firestore 읽기·쓰기, **인덱스**는 Cloud Datastore Index Admin, **Rules**는 Firebase Rules 관리 권한입니다. **설정**은 Firebase 관리 API나 해당 제품 구성 권한입니다. 여러 자원을 쓰는 명령에는 해당 권한이 함께 필요합니다. [Firebase IAM 역할](https://firebase.google.com/docs/projects/iam/roles)
- 같은 운영 프로젝트의 쓰기 작업은 한 담당자가 맡습니다. 개인 폴더의 잠금 파일은 현재 PC의 동시 실행을 막습니다. 다른 기기에서는 별도 조율이 필요합니다.

## Firebase 초기 설정

| 명령과 인자 | 권한 | 검사와 적용 범위 |
| --- | --- | --- |
| `setup-status` | 설정, Auth, Rules, 인덱스, 데이터 읽기 | 기본 DB, 이메일 인증·도메인, Rules, 인덱스, 재고 상태를 읽습니다. |
| `setup [--domain HOST] [--apply]` | 설정, Auth, Rules, 인덱스, 데이터 | 전체 상태를 먼저 검사합니다. 적용하면 Rules와 복합 인덱스, 재고 초기화, 인증 설정을 처리합니다. DB·웹 앱·회원 생성에는 개별 명령을 사용합니다. |
| `db-create --location LOCATION [--apply]` | Firestore DB 생성 | 미설치 시 Standard Native `(default)` DB 생성 요청을 보냅니다. 기존 DB의 위치와 설정은 유지합니다. |
| `auth-config [--domain HOST] [--apply]` | Authentication 설정 | 이메일/비밀번호 상태와 도메인 변경을 표시합니다. 적용 시 이메일/비밀번호를 켜고 지정한 도메인을 추가합니다. 기존 도메인을 보존합니다. |
| `web-apps` | Firebase 앱 읽기 | 프로젝트의 웹 앱 목록을 확인합니다. |
| `web-app-create --name NAME [--apply]` | Firebase 앱 생성 | 같은 표시 이름을 확인하고 대상이 없으면 웹 앱 생성 요청을 보냅니다. |
| `web-config [--app-id APP_ID]` | Firebase 앱 구성 읽기 | 공개 웹 SDK 설정 네 개를 출력합니다. 앱이 여러 개면 ID를 지정해야 합니다. |
| `rules-status` | Rules 읽기 | 배포 중인 Rules와 패키지 Rules의 SHA-256을 비교합니다. |
| `rules-deploy [--apply]` | Rules | 적용 시 현재 Rules를 개인 폴더에 백업하고 패키지 버전을 적용합니다. 기존 데이터는 그대로 보관됩니다. |
| `rules-rollback --ruleset ID [--apply]` | Rules | 지정한 이전 Ruleset을 확인합니다. 백업의 `name`에서 마지막 ID를 가져옵니다. 적용 시 현재 버전도 백업합니다. |
| `indexes-status` | 인덱스 읽기 | 패키지가 요구하는 복합 인덱스와 서버 상태를 비교합니다. |
| `indexes-deploy [--apply]` | 인덱스 | 누락된 복합 인덱스를 생성합니다. 기존 인덱스와 단일 필드 설정을 보존합니다. |
| `inventory-init [--apply]` | 데이터 | 물품·대여·번호 예약 정합성과 변경 예정 수를 확인합니다. 적용 시 누락 예약과 필요한 필드를 보완한 뒤 준비 상태를 기록합니다. |

~~~sh
rental-setup --project PROJECT_ID setup --domain rental.example.test
rental-setup --project PROJECT_ID indexes-deploy --apply
rental-setup --project PROJECT_ID indexes-status
rental-setup --project PROJECT_ID rules-rollback --ruleset RULESET_ID
~~~

인덱스 생성 요청이 먼저 완료되고 조회는 인덱스 준비 이후 가능해집니다. `READY`를 확인한 뒤 실제 테스트 계정으로 조회하세요. 앱의 물품 읽기 오류와 번호 등록 잠금이 함께 보이면 `indexes-status`와 `inventory-init` 사전 검사를 각각 실행합니다. `setup`을 재시도하기 전에 이미 적용된 단계를 `setup-status`에서 확인합니다.

## 학생 계정

아래 명령은 검증된 학생 계정만 변경하며, 관리자나 UID·이메일·클레임·프로필의 연결을 확인할 수 없는 계정은 보호합니다. 일괄 작업은 개인별 성공과 실패를 대조합니다.

| 명령과 인자 | 권한 | 검사와 적용 범위 |
| --- | --- | --- |
| `list [--query 검색어] [--grade 1\|2\|3]` · `show 학번` | Auth, 데이터 읽기 | 이름, 학년과 계정 상태를 조회합니다. 출력에 학생 정보가 들어 있습니다. |
| `register --roster JSON [--journal JSON] [--initial-password 값] [--apply]` | 검사는 로컬, 적용은 Auth·데이터 | 형식·중복, 재개용 기록을 검사합니다. 적용하면 기존 계정을 보호하면서 대상의 Auth와 Firestore 프로필을 새로 발급합니다. |
| `add 학번 --name 이름 [--grade 1\|2\|3] [--initial-password 값] [--apply]` | 검사는 로컬, 적용은 Auth·데이터 | 같은 발급 과정을 한 학생에게 실행합니다. |
| `edit 학번 [--name 이름] [--grade 1\|2\|3] [--apply]` | Auth, 데이터 | 적어도 하나의 필드를 지정합니다. 프로필의 이름·학년을 변경하며 UID, 비밀번호와 대여 기록을 유지합니다. |
| `reset 학번 [--initial-password 값] [--apply]` · `reset-all [--initial-password 값] [--apply]` | Auth, 데이터 읽기 | 임시 비밀번호를 발급하고 기존 갱신 토큰을 폐기합니다. 파일에 기록하고 성공을 확인한 항목만 전달합니다. 프로필과 활성 상태는 유지합니다. |
| `enable 학번 [--apply]` · `enable-all [--apply]` | Auth, 데이터 | 현재 비밀번호로 로그인할 수 있게 Auth와 프로필을 활성화합니다. 공통 비밀번호를 가진 계정에는 미리 개인 비밀번호를 발급합니다. |
| `disable 학번 [--apply]` · `disable-all [--apply]` | Auth, 데이터 | 미반납 건을 확인합니다. 프로필과 Auth를 비활성화하고 갱신 토큰을 폐기합니다. |
| `delete 학번 [--apply]` · `delete-all [--apply]` | Auth, 데이터 | 미반납 및 불확실한 상태를 확인합니다. Auth 계정을 제거하고 비활성 프로필과 대여 이력을 보존합니다. |
| `purge 학번 [--apply]` · `purge-all [--apply]` | Auth, 데이터 | Auth와 대여 기록이 모두 없는 보관 프로필만 제거합니다. |
| `sync --roster JSON [--apply]` | Auth, 데이터 | 기존 학생의 이름과 현재 학년을 확인하고 적용합니다. 신규·누락 인원은 건수로 표시합니다. 신규 발급과 비활성화는 개별 검토가 필요합니다. |
| `doctor` | Auth, 데이터 읽기 | Auth와 프로필·역할 간 정합성 상태를 요약합니다. |
| `private-path` · `audit` | 로컬 | 프로젝트별 개인 작업 폴더와 감사 로그 경로를 확인합니다. |

`OHSUNG_ROSTER`를 명시적으로 설정하면 `register`, `sync`의 명단 기본값으로 사용할 수 있습니다. `--journal`은 해당 프로젝트의 개인 폴더 바로 아래 파일을 지정하세요. 발급 기록은 사전 또는 실패 항목의 비밀번호도 보관할 수 있으므로 실행 결과와 대조하세요. 반복 실행 때 초기 비밀번호를 다시 발급하지 않도록 원래 명단·옵션·기록을 사용합니다. 개별 변경 명령의 동시 처리 수는 `--concurrency 1`부터 `10`까지입니다.

~~~sh
rental-setup --project PROJECT_ID show 2600001
rental-setup --project PROJECT_ID edit 2600001 --grade 2
rental-setup --project PROJECT_ID edit 2600001 --grade 2 --apply
rental-setup --project PROJECT_ID reset 2600001 --apply
rental-setup --project PROJECT_ID sync --roster "/path/to/private/students.json"
~~~

기존 도구에서 발급이 중단된 계정, 학번 수정, 과거 해시 UID, 대여 이력이 붙은 계정의 재발급은 `doctor`와 원래 기록을 먼저 검토합니다. 일괄 삭제 이후 복원은 별도 절차입니다.

일괄 발급은 잠금 파일의 Firebase Admin SDK 14.5.1에 맞춘 호환 계층으로 `importUsers()`에 덮어쓰기 금지와 이메일 중복 검사를 추가합니다. SDK를 갱신할 때는 모의 요청 검사와 별도 Firebase 프로젝트의 가상 계정 발급·로그인까지 확인합니다. [Auth 일괄 등록 API](https://cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/batchCreate)

## 관리자

| 명령과 인자 | 권한 | 검사와 적용 범위 |
| --- | --- | --- |
| `admins-list` | 데이터 읽기 | 웹 관리자 역할 목록을 읽습니다. |
| `admin-add --email EMAIL --name NAME [--apply]` | Auth, 데이터 | 기존 이메일과 충돌을 확인합니다. 신규 계정은 비활성 상태에서 생성하고 프로필·역할을 확인한 후 활성화합니다. |
| `admin-grant --email EMAIL --name NAME [--apply]` | Auth, 데이터 | 학생이 아닌 계정의 이메일 검증과 활성 상태를 확인하고 프로필·역할을 설정합니다. |
| `admin-revoke --email EMAIL [--apply]` | Auth, 데이터 | 로그인 가능한 다른 관리자를 확인한 뒤 웹 앱 권한을 회수하고 갱신 토큰을 폐기합니다. Google Cloud IAM은 그대로 유지합니다. |

~~~sh
rental-setup --project PROJECT_ID admin-grant --email admin@example.test --name "가상 관리자"
rental-setup --project PROJECT_ID admin-revoke --email admin@example.test
~~~

`admin-add`가 중단되면 개인 초기 비밀번호 파일, Auth 계정, `users/{uid}`, `roles/{uid}`를 대조합니다. 다시 실행하기 전에 기존 계정 상태를 확인하세요.

## 물품과 대여

| 명령과 인자 | 권한 | 검사와 적용 범위 |
| --- | --- | --- |
| `products-list` · `rentals-summary` | 데이터 읽기 | 물품 목록 또는 대여 상태별 건수를 확인합니다. |
| `products-add --category CAT --name NAME --number N [--apply]` | 데이터 | 분류별 중복 번호를 검사한 뒤 물품과 번호 예약을 같이 기록합니다. |
| `products-import --file JSON [--apply]` | 데이터 | [예시 형식](../products.example.json)을 검사하고 항목별 트랜잭션으로 등록합니다. 동일한 번호와 내용은 기존 항목으로 처리합니다. |
| `products-edit --id ID [--category CAT] [--name NAME] [--number N] [--apply]` | 데이터 | 변경할 필드를 하나 이상 지정합니다. 가용 물품의 정보와 필요한 번호 예약을 갱신합니다. |
| `products-enable --id ID [--apply]` · `products-disable --id ID [--apply]` | 데이터 | 물품의 사용 가능 여부를 바꾸며 대여 상태, 예약과 이력을 보존합니다. |

~~~sh
rental-setup --project PROJECT_ID products-add --category "우산" --name "공용 우산" --number 1
rental-setup --project PROJECT_ID products-edit --id PRODUCT_ID --name "공용 우산" --apply
~~~

중복 번호가 나오면 기존 물품과 `productNumbers` 예약의 연결을 먼저 확인합니다. 일괄 등록이 일부만 성공하면 성공 항목을 확인한 뒤 같은 파일로 재실행합니다. 대여와 반납 승인은 웹 관리자 콘솔에서 진행합니다.

## Firebase 설정 동기화

기본 검사는 패키지에 포함된 설정을 기준 웹 커밋의 SHA-256과 대조합니다. 운영 명령은 검증된 로컬 사본으로 실행됩니다.

~~~sh
npm run config:check
npm run config:check -- --source "../ohsung-rental-deploy"
npm run config:sync -- --source "../ohsung-rental-deploy" --commit WEB_COMMIT_SHA
npm run config:check -- --source "../ohsung-rental-deploy"
npm test
~~~

경로는 로컬 웹 저장소에 맞게 바꾸고 `WEB_COMMIT_SHA`에는 승인된 웹 커밋의 40자리 SHA를 입력합니다. 소스 비교는 깨끗한 웹 체크아웃에서 실행합니다. 도구는 로컬 Git 객체에서 Rules, 복합 인덱스, Firebase 설정과 학생 ID 변환 모듈을 가져옵니다. [출처 매니페스트](../config/firebase-config-provenance.json)에 각 파일의 SHA-256과 커밋을 기록합니다. 검사에서 불일치가 보고되면 차이를 검토하고 검증된 버전으로 동기화합니다. 이 명령은 Firebase 배포를 수행하지 않습니다.

## 자주 생기는 오류

- **인증 또는 권한이 부족함** — 작업 대상과 로그인 계정을 확인하고 해당 기능의 IAM 권한을 운영 책임자와 대조합니다.
- **기본 DB 없음 또는 Auth 초기화 필요** — 프로젝트의 Firestore와 Authentication을 먼저 준비한 뒤 `setup-status`를 재시도합니다.
- **개인 폴더 권한 오류** — Windows는 `install.ps1` 또는 학교의 승인된 ACL 절차를 사용합니다. Unix는 폴더를 본인 소유 `0700`, 자격 증명과 기록을 `0600`으로 보관합니다.
- **중단 뒤 잠금이 남음** — 다른 운영 프로세스가 종료됐는지 확인하고 `private-path`의 `.student-admin.lock`만 정리한 뒤 원래 기록으로 재시도합니다.
- **Rules를 이전 버전으로 돌려야 함** — 개인 폴더의 백업에서 대상 프로젝트와 Ruleset ID를 확인하고 `rules-rollback`을 검사한 뒤 적용합니다. 복원 후 `rules-status`를 다시 확인합니다.
