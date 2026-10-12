# gemini-lb

Gemini API와 Code Assist 계정을 로컬에서 묶어 사용하는 셀프 호스팅 게이트웨이입니다. Soju06/codex-lb에서 영감을 받은 독립 구현이며, 포크나 기능 동등성을 주장하지 않습니다.

**0.1.0 초기 릴리스:** 지원 범위는 [contract](docs/contract.md)에 한정됩니다. 실제 Google 계정·과금·서비스와의 라이브 검증은 아직 하지 않았습니다. 로컬 테스트 성공은 Google 호환성 보증이 아닙니다. 본인에게 사용 권한이 있는 계정만 등록하고 Google 약관·할당량·조직 정책을 준수하세요. Code Assist는 비공개 API에 의존하므로 언제든 바뀔 수 있습니다.

```text
Gemini CLI / native SDK
  -> client key -> gemini-lb (127.0.0.1:2456)
                    |-> API-key accounts -> Gemini API
                    |-> OAuth accounts   -> Code Assist
                    `-> SQLite + encrypted credentials
Operator -> separate admin token -> dashboard /admin/*
```

## 시작

Node.js 24 이상이 필요합니다. CLI 인수로 비밀 값을 넘기지 말고, 권한을 제한한 파일을 사용하세요.

```sh
git clone https://github.com/deploy103/gemini-lb.git
cd gemini-lb
npm ci
npm run build
node dist/cli.js init
# admin token과 기본 client key는 여기서 한 번만 출력됩니다. 안전하게 보관하세요.
node dist/cli.js account add --name personal --project my-google-project --key-file /secure/api-key.txt
node dist/cli.js account list
node dist/cli.js key create --name laptop --accounts ACCOUNT_ID
node dist/cli.js serve
```

기본 데이터 디렉터리는 `~/.gemini-lb`, 리스너는 `127.0.0.1:2456`입니다. `init`, `serve`는 `--data-dir PATH`를 지원하며 `GEMINI_LB_DATA_DIR`로도 지정할 수 있습니다. `serve`는 `--host HOST --port PORT`를 지원합니다. `init`과 오프라인 계정 명령은 서버 실행 중 거부됩니다. 실행 중 변경은 별도 admin token으로 대시보드·관리 API를 사용하세요.

```sh
node dist/cli.js account disable --id ACCOUNT_ID
node dist/cli.js account enable --id ACCOUNT_ID
```

### OAuth 계정

먼저 공식 Gemini CLI에서 로그인·온보딩을 완료하세요. 0.1에는 브라우저 OAuth, 프록시 온보딩, Google 계정 변경 프록시 API가 없습니다. 로컬 풀 계정 관리는 admin API로 지원합니다.

```sh
node dist/cli.js account import --name cli --project my-google-project --file /secure/oauth.json --oauth-client /secure/client.json
```

가져오기는 원본 파일을 수정하지 않습니다. `access_token` + `expiry_date`만 있어도 사용할 수 있지만 갱신은 불가능합니다. 자동 갱신에는 `refresh_token`과 일치하는 `client_id` / `client_secret`이 필요합니다. 일반 CLI 캐시에는 OAuth 클라이언트 등록 정보가 없으므로 별도로 제공해야 합니다. `--oauth-client`는 Google에서 내려받은 `installed` 또는 `authorized_user` 클라이언트 JSON을 받습니다. 임의의 다른 클라이언트를 섞지 마세요. 만료·`invalid_grant` 상태는 올바른 자격 증명 재가져오기로 복구하세요.

## 클라이언트 연결

아래 값은 예시 자리표시자입니다. 실제 키는 안전한 환경 주입으로 전달하세요. upstream Google 키가 아니라 **gateway client key**를 사용합니다.

Gemini CLI API-key 모드: 반드시 API-key/gateway 인증을 선택하고 Google 로그인/Vertex 모드를 사용하지 마세요.

```sh
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:2456
export GEMINI_API_KEY='<gateway client key>'
export GOOGLE_GENAI_API_VERSION=v1beta
gemini
```

Code Assist 모드: 공식 CLI에서 이미 온보딩한 OAuth 계정을 등록한 뒤 사용합니다.

```sh
export CODE_ASSIST_ENDPOINT=http://127.0.0.1:2456
export GOOGLE_GENAI_USE_GCA=true
export GEMINI_CLI_CUSTOM_HEADERS='x-gemini-lb-key: <gateway client key>, x-gemini-lb-session: stable-session-id'
gemini
```

참조 CLI의 커스텀 헤더 형식은 JSON이 아니라 `name: value`이며 여러 헤더는 쉼표로 구분합니다. 위 환경 설정은 라이브 검증되지 않았습니다. 이전 모드 환경 변수는 해제하고 CLI 인증 선택도 확인하세요.

일반 HTTP 클라이언트는 `x-goog-api-key`, `Authorization: Bearer <gateway client key>`, 또는 `x-gemini-lb-key`로 인증합니다. Code Assist의 Google bearer보다 커스텀 키가 우선합니다. 네이티브 멀티턴은 `x-gemini-lb-session`을 반드시 유지하세요. `cachedContent`, `fileData`, `thoughtSignature` 참조에는 명시적인 `x-gemini-lb-account` 또는 이미 연결된 세션이 필요하며, 없으면 409입니다. 리소스 소유권은 운영자가 관리합니다.

## 지원 범위

| 경로                                                                                                                              | 계정 / 동작                                                  |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /healthz`                                                                                                                    | 인증 없는 생존 확인만                                        |
| `/v1beta/models/:model:generateContent`, `:streamGenerateContent?alt=sse`, `:countTokens`, `:embedContent`, `:batchEmbedContents` | POST, API-key 계정; `/v1`도 지원                             |
| `/v1beta/models`, `/v1beta/models/:model`                                                                                         | GET, upstream 모델 조회·allowlist 적용; `/v1`도 지원         |
| `/v1internal:generateContent`, `:streamGenerateContent?alt=sse`, `:countTokens`                                                   | POST, OAuth 계정, Code Assist envelope 보존·project 교체     |
| `/v1internal:loadCodeAssist`, `:retrieveUserQuota`, `:fetchAdminControls`, `:listExperiments`                                     | POST, 선택된 OAuth 계정; 이미 온보딩된 계정 필요             |
| `/v1internal:recordCodeAssistMetrics`                                                                                             | 인증 후 로컬 204, 외부 전송 없음                             |
| `/admin/*`                                                                                                                        | 별도 admin Bearer token; 계정·키·할당량·요청 메타데이터 관리 |

Vertex, OpenAI 변환, Live/WebSocket, Interactions, Files/upload 및 파일 수명주기, caches 수명주기, batch jobs, operations, 다중 replica는 지원하지 않습니다. 미지원 추론 경로는 501이며 유료 크레딧 opt-in 요청도 거부합니다.

계정별 모델 allowlist(빈 목록은 전체), 동시 요청 제한(기본 4), client key별 계정 scope를 지원합니다. 최소 in-flight 계정을 선택하며 같은 project의 API 키는 모델 cooldown을 공유합니다. 최대 3회, 서로 다른 계정으로만 재시도하고 401/403 또는 출력 시작 이후에는 이동·재생하지 않습니다. 세션은 24시간 고정됩니다. 일일 quota 오류에 지연 정보가 없으면 보수적으로 24시간 cooldown하며 정확한 초기화 시각을 추측하지 않습니다. API-key quota 비율도 만들어내지 않습니다.

기본 요청 제한시간은 120초, 본문 제한은 16 MiB, 요청 이력은 메타데이터 1,000행으로 제한됩니다. [구조](docs/architecture.md)와 [보안·백업](docs/security.md)을 확인하세요.

## Docker

```sh
docker compose build
docker compose run --rm gemini-lb init
# 출력된 토큰을 안전하게 보관한 후 시작
docker compose up -d
docker compose logs gemini-lb
docker compose down
```

Node 24 다단계 이미지, UID 1000, `/data` 영속 볼륨을 사용합니다. 컨테이너 내부는 `0.0.0.0:2456`, 호스트 공개는 `127.0.0.1:2456`뿐입니다. 서버가 실행 중일 때 별도 `init`을 실행하지 마세요. 원격 접속에는 인증을 유지한 TLS reverse proxy가 필요합니다. 자동 배포 설정은 없습니다.

## 개발·출처

```sh
npm ci
npm run check
npm test
npm run build
npm run format:check
```

CI는 위 검증만 수행하며 publish/deploy하지 않습니다. 릴리스 전 의존성 audit·secret review와 실제 계정 검증은 별도로 필요합니다.

로컬 HTTP upstream과 공식 `@google/genai` SDK로 라우팅·스트리밍·도구/서명 보존·토큰 동시 갱신·quota cooldown·세션 고정·인증 경계를 검증했습니다. 실제 브라우저에서도 계정 등록/활성화, quota 조회, scoped key 발급/폐기, 모바일 레이아웃과 새로고침 시 로그아웃을 확인했습니다. Docker는 이 개발 환경의 소켓 권한 제한으로 빌드/실행하지 못했습니다. OAuth quota는 자동 polling하지 않으며 관리자가 수동 갱신합니다. 통계는 보존된 최대 1,000개 요청 기준입니다.

원본 소스를 복사하지 않고 프로토콜을 참고한 독립 구현입니다. 이 프로젝트는 [MIT](LICENSE), Copyright 2026 deploy103입니다. 참고 자료의 라이선스는 각 프로젝트에 적용됩니다.

- [Soju06/codex-lb 참조 리비전](https://github.com/Soju06/codex-lb/tree/f8ffbac2099a113fba54dfd8d77774f5bca80ffa), MIT.
- [google-gemini/gemini-cli 참조 리비전](https://github.com/google-gemini/gemini-cli/tree/9b6e0265d16bbd29ca51e33c9e0c01dc4cec5e83), Apache-2.0 (`contentGenerator.ts`, `customHeaderUtils.ts`).
- 공식 [Gemini API REST reference](https://ai.google.dev/api), [API key 안내](https://ai.google.dev/gemini-api/docs/api-key), [Gemini CLI 인증 안내](https://geminicli.com/docs/get-started/authentication/), [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2).
