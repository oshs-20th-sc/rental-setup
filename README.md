# rental-setup

**빌리러 오성**의 Firebase 구축과 운영을 맡는 학생회 담당자용 CLI입니다. 웹 프로젝트를 내려받지 않아도 Windows, macOS, Linux에서 같은 패키지를 설치할 수 있습니다.

## CLI의 역할

Firebase 프로젝트의 설정, Rules, 인덱스, 학생 계정, 웹 관리자 권한, 물품 번호와 재고를 관리합니다. [웹사이트 저장소](https://github.com/oshs-20th-sc/ohsung-rental)는 로그인, 대여·반납, 관리자 화면과 정적 배포를 관리합니다.

## Windows 설치

Node.js **24.22.3 이상 24.x**와 npm을 설치한 뒤, 승인된 버전의 저장소를 압축 해제합니다. PowerShell에서 압축을 푼 폴더를 열고 실행합니다.

~~~powershell
powershell.exe -NoProfile -File .\install.ps1
npm.cmd run login
.\rental-setup.cmd help
~~~

학교 정책에서 설치 스크립트가 제한되면 승인된 방식으로 `npm.cmd ci`와 `npm.cmd test`를 실행하세요. 예제의 `rental-setup`은 PowerShell에서 `.\rental-setup.cmd`, CMD에서 `rental-setup.cmd`로 실행할 수 있습니다. 공백과 한글이 있는 경로는 큰따옴표로 감싸세요. CMD 특수문자가 포함된 인자는 `node .\bin\rental-setup.cjs`로 직접 실행합니다.

## macOS와 Linux 설치

같은 Node.js 버전을 사용합니다. 저장소 폴더에서 실행합니다.

~~~sh
npm ci
npm test
npm run login
node bin/rental-setup.cjs help
~~~

`npm link`를 실행하면 `rental-setup` 명령을 등록할 수 있습니다. 아래 예제의 명령을 `node bin/rental-setup.cjs`로 시작해도 됩니다.

## Firebase 로그인과 IAM

학교가 승인한 Google 계정에 작업에 필요한 IAM 권한을 부여합니다. Authentication, Firestore 데이터·인덱스, Rules, 프로젝트·웹 앱 설정에 필요한 권한은 별개입니다. 웹 앱의 `roles/{uid}`는 앱 내부 권한입니다. [Firebase IAM 역할](https://firebase.google.com/docs/projects/iam/roles)

`npm run login`으로 패키지에 고정된 Firebase CLI에 로그인합니다. 이미 승인된 Application Default Credentials(ADC)가 있으면 `OHSUNG_USE_ADC=1` 또는 `GOOGLE_APPLICATION_CREDENTIALS`로 사용할 수 있습니다. 일반 실행에는 Firebase CLI 15.37.0 로그인을 재사용하며, 이때 생성한 개인 폴더의 임시 인증 파일은 프로세스 종료 시 정리합니다. [ADC 안내](https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)

명령 앞에 `--project PROJECT_ID`를 붙여 대상을 명시하세요. 생략 시 기본 프로젝트는 `ohsung-rental`입니다. 변경 명령은 기본적으로 사전 검사만 합니다. `--apply`로 호출한 뒤 표시된 확인 문구를 입력하면 실제 적용됩니다.

## 신규 Firebase 프로젝트 구축

1. **Firebase 콘솔**에서 프로젝트를 만들고 **Authentication → 시작하기**를 실행합니다. 무료 Spark 프로젝트의 최초 활성화는 콘솔에서 합니다. 필요한 API 활성화와 IAM 권한 부여도 콘솔에서 확인합니다. [Firebase 프로젝트 안내](https://firebase.google.com/docs/projects/learn-more) · [Authentication 초기화 API](https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects.identityPlatform/initializeAuth)
2. **CLI**를 설치하고 로그인합니다. `setup-status`로 대상을 확인합니다. 새 프로젝트에서 기본 Firestore가 없다는 출력은 예상된 결과입니다.
3. **CLI**에서 Standard Native 기본 Firestore를 생성합니다. 아래 지역은 예시이므로 학교 기준에 맞게 선택합니다. 생성 완료 후 `setup-status`를 다시 확인합니다.
4. **CLI**에서 Firebase 웹 앱을 등록합니다. 앱이 이미 있으면 `web-apps`에서 선택할 수 있습니다.

~~~sh
rental-setup --project PROJECT_ID setup-status
rental-setup --project PROJECT_ID db-create --location asia-northeast3
rental-setup --project PROJECT_ID db-create --location asia-northeast3 --apply
rental-setup --project PROJECT_ID web-app-create --name "빌리러 오성" --apply
rental-setup --project PROJECT_ID web-apps
~~~

### Rules, 복합 인덱스와 인증 설정

5. **CLI**에서 Rules, 복합 인덱스, 물품 번호 예약, 이메일/비밀번호 로그인과 승인 도메인을 검사합니다. `HOST`는 `rental.coshsc.kr`처럼 프로토콜과 경로를 뺀 호스트로 바꿉니다.
6. **CLI**에서 설정을 적용합니다. 중단되면 `setup-status`로 상태를 확인하세요. `indexes-status`에서 필요한 인덱스가 모두 `READY`인지 확인하고 웹에서 조회를 검증합니다.

~~~sh
npm run config:check
rental-setup --project PROJECT_ID setup --domain HOST
rental-setup --project PROJECT_ID setup --domain HOST --apply
rental-setup --project PROJECT_ID rules-status
rental-setup --project PROJECT_ID indexes-status
~~~

Rules와 복합 인덱스의 기준 원본은 웹 저장소입니다. [설정 출처 기록](config/firebase-config-provenance.json)에서 기준 커밋과 SHA-256을 확인하고, [설정 동기화 방법](docs/commands.md#firebase-설정-동기화)에 따라 갱신합니다.

복합 인덱스는 Firestore의 조회 설정입니다. `productNumbers`는 분류별 번호 중복을 막는 앱 데이터이며 `inventory-init`이 준비합니다. 기존 재고가 있으면 사이트 사용과 관리자 쓰기를 중지한 점검 시간에 초기화합니다.

### 관리자 생성과 가상 계정 검증

7. **CLI**에서 승인된 이메일로 관리자를 추가하고 역할을 확인합니다. 개인 작업 폴더에서 초기 비밀번호를 확인합니다.
8. **승인된 테스트 프로젝트**에서 가상 학생으로 7자리 ID 로그인, 대여·반납, 관리자 승인을 검증합니다. [가상 학생 명단](students.example.json)

~~~sh
rental-setup --project PROJECT_ID admin-add --email admin@example.test --name "가상 관리자" --apply
rental-setup --project PROJECT_ID admins-list
rental-setup --project TEST_PROJECT_ID register --roster students.example.json --apply
~~~

## 학생 명단 JSON과 일괄 등록

학번은 입학 당시 7자리 문자열로 고정합니다. 현재 학년은 1~3 정수이며 생략할 수 있습니다. 신규 학생의 Auth UID와 `users/{uid}` 문서 ID에는 이 학번이 쓰입니다.

~~~json
[
  { "studentId": "2600001", "name": "가상 학생", "grade": 1 }
]
~~~

9. **CLI**에서 저장소 밖 실제 명단을 검사합니다. 적용하기 전에 Auth UID, 이메일, 프로필과 역할 충돌을 추가로 검사합니다. Auth 발급은 최대 1,000명 단위입니다.
10. 적용 후 결과 건수를 확인하고 성공한 학생에게 개인 비밀번호를 전달합니다. 중단되면 같은 프로젝트, 명단, 옵션과 발급 기록으로 재실행합니다.

~~~sh
rental-setup --project PROJECT_ID register --roster "/path/to/private/students.json"
rental-setup --project PROJECT_ID register --roster "/path/to/private/students.json" --apply
~~~

개인별 임시 비밀번호가 기본입니다. 공통 비밀번호로 신규 발급된 계정은 비활성 상태로 시작합니다. 학생별 비밀번호를 다시 설정한 뒤 활성화합니다. CLI는 Firestore BulkWriter로 비활성 프로필을 먼저 준비하고, Auth 결과와 프로필 소유권을 확인한 뒤 트랜잭션으로 등록을 확정합니다.

## 학생 개별 관리

`show`로 상태를 확인하고 `add`, `edit`, `reset`, `enable`, `disable`을 필요에 따라 실행합니다. 이름 변경은 이후 대여에 반영됩니다. `delete`는 Auth 계정을 제거하고 비활성 프로필과 과거 대여 기록을 보존합니다. 미반납 건이 있으면 먼저 반납을 처리합니다. [학생 명령 참조](docs/commands.md#학생-계정)

## 관리자 권한 관리

`admins-list`로 역할을 확인하고, `admin-grant`로 이메일이 확인된 기존 활성 계정에 권한을 부여합니다. `admin-revoke`는 로그인 가능한 다른 관리자가 있을 때만 적용됩니다. [관리자 명령 참조](docs/commands.md#관리자)

## 물품 관리

11. **CLI** 또는 웹 관리자 콘솔로 운영 물품을 등록합니다. `products-add`는 한 건, `products-import`는 JSON 목록을 처리합니다. 물품과 번호 예약은 같은 트랜잭션에서 기록합니다. 대여 중에는 사용 여부만 바꿀 수 있습니다. [가상 물품 목록](products.example.json) · [물품 명령 참조](docs/commands.md#물품과-대여)

~~~sh
rental-setup --project PROJECT_ID products-import --file products.example.json
rental-setup --project PROJECT_ID products-import --file "/path/to/private/products.json" --apply
~~~

## 학년도 갱신

`sync --roster JSON`으로 기존 학생의 이름과 학년 변경을 확인하고 적용합니다. 신규 학생은 `register`로 처리합니다. 졸업·전출 계정은 학교 기준과 미반납 여부를 검토해 별도로 비활성화합니다. 학번과 UID는 그대로 사용합니다.

## Firebase 웹 환경변수와 배포

12. **CLI**에서 `web-config`를 실행합니다. 웹 앱이 여러 개면 `--app-id APP_ID`를 붙입니다.
13. **Cloudflare Pages 콘솔**에서 아래 네 값을 Production 환경변수에 넣고 웹을 다시 빌드·배포합니다. GitHub Pages는 Actions 변수를 저장하고 수동 워크플로를 실행합니다.
14. **운영 확인**에서 학생·관리자 로그인, 물품 조회, 대여·반납, 승인과 이력 조회를 확인합니다. [웹사이트 배포 안내](https://github.com/oshs-20th-sc/ohsung-rental#readme)

~~~sh
rental-setup --project PROJECT_ID web-config
~~~

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

Firebase를 교체할 때는 새 프로젝트를 같은 순서로 구축하고 웹 변수 네 개를 바꿉니다. 기존 비밀번호 해시와 대여 이력 이전은 별도 작업이며, 이 CLI의 복원 범위는 Rules입니다.

## 명령어, 오류와 복구

[전체 명령어 참조](docs/commands.md)에서 명령별 옵션, IAM 권한, 변경 내용과 재시도를 확인합니다. 계정 연결 상태는 `doctor`, 변경 결과는 `audit`, 개인 작업 폴더는 `private-path`로 확인합니다.

## 개인정보와 인수인계

명단, 관리자 인증 파일, 발급·초기화 기록, 로그와 Rules 백업은 저장소와 분리합니다. 기본 개인 작업 폴더는 macOS/Linux에서 `~/.ohsung-rental-private`, Windows에서 `%LOCALAPPDATA%\OhsungRental-private`입니다. 다른 프로젝트에는 프로젝트별 접미사가 붙습니다. 로그에도 학번 등 개인정보가 포함될 수 있습니다.

후임에게 프로젝트 ID, CLI 버전, 설정 기준 웹 커밋, 배포 도메인, 학교의 데이터 보관과 계정 회수 기준을 전달합니다. 후임은 자신에게 승인된 Google 계정으로 로그인하고, 인수인계 후 이전 담당자의 IAM과 웹 관리자 권한을 검토합니다.

## 검증과 라이선스

`npm test`와 `npm run config:check`는 로컬에서 실행할 수 있습니다. Auth Emulator는 일괄 등록 때 전달한 외부 해시로 로그인하는 흐름을 검증할 수 없으므로, 운영 적용 전 학교가 승인한 별도 Firebase 프로젝트에서 가상 계정 발급 직후 로그인까지 확인합니다. [라이선스](LICENSE)
