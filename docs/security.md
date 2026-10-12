# Security and operations — 0.1

이 게이트웨이는 운영자가 신뢰하는 단일 호스트를 전제로 합니다. 라이브 Google 검증은 아직 없으며, Code Assist 비공개 API 사용은 해당 계정의 권한·약관·조직 정책을 확인해야 합니다. 풀링은 quota 우회나 유료 크레딧 자동 동의 기능이 아닙니다.

## 비밀과 경계

- upstream 계정 자격 증명, gateway client key, admin token은 서로 대체할 수 없습니다. client key는 추론만 허용하며 admin token은 별도 관리 인증입니다.
- 계정 자격 증명은 AES-256-GCM(무작위 nonce, account ID AAD)으로 암호화합니다. client key는 SQLite에 해시로 저장합니다. `secrets.json`에는 암호화 master key와 admin token 해시가 있으며 mode 0600, 데이터 디렉터리는 mode 0700입니다.
- 암호화 키와 데이터가 같은 호스트에 있으므로 호스트·운영자 권한 탈취를 막는 장치는 아닙니다. 관리자와 백업 접근 권한을 최소화하세요. SQLite 및 WAL도 비밀 데이터로 취급하세요.
- `init`의 admin token·기본 client key와 새 key 생성 결과는 한 번만 표시됩니다. 셸 인수에 비밀을 넣지 말고 보호된 파일·환경 주입을 사용하세요. 환경 변수도 프로세스/컨테이너 관리자에게 보일 수 있습니다.
- OAuth import는 원본 캐시를 수정하지 않습니다. 캐시만으로 refresh client registration을 얻을 수 없으며, 일치하는 OAuth 클라이언트 정보를 별도로 제공하세요. access token만 가져오면 만료 후 재가져오기가 필요합니다.

## 네트워크와 접근

기본 `127.0.0.1:2456`를 유지하세요. Docker는 내부 `0.0.0.0`에 바인딩하되 호스트에는 루프백만 공개합니다. 원격 사용 시 TLS reverse proxy와 접근 제어를 구성하고 `/admin/*`를 특히 제한하세요. 애플리케이션 인증을 끄거나 공개 인터넷에 직접 노출하지 마세요. 프록시와 브라우저 도구에서도 토큰·본문 로그를 남기지 않도록 설정하세요.

관리 API는 cross-origin browser 요청을 거부하고 CORS를 제공하지 않습니다. 대시보드 token은 메모리만 사용합니다. 같은 origin의 악성 코드나 탈취된 호스트까지 보호하지는 못합니다. `/healthz`는 계정 정보를 노출하지 않는 liveness 경로입니다.

client key를 계정 scope로 제한하고 계정 model allowlist와 동시성 제한을 사용하세요. 빈 model 목록은 모든 모델을 허용합니다. 필요 없는 키는 관리 API에서 revoke하고, 계정은 disable하세요. disable은 세션 소유권과 이력을 보존하므로 pinned 세션이 다른 계정으로 자동 이동하지 않습니다. 리소스 참조에는 명시적 계정 또는 기존 세션이 필요하며 소유권은 운영자 책임입니다.

Google bearer나 query key는 upstream으로 전달하지 않습니다. 저장된 계정 자격 증명만 사용하고 arbitrary headers/cookies를 전달하지 않습니다. upstream 비밀·프롬프트·응답 본문은 로그에 기록하지 않고 외부 telemetry도 없습니다. 메타데이터 이력(최대 1,000행)은 모델, 계정, 시간, 사용량 등 민감한 운영 정보를 포함할 수 있습니다.

## 백업·복구

1. 서버를 정상 중지하고 데이터 디렉터리의 단일 프로세스 lock 소유자가 종료됐는지 확인하세요. 서버 실행 중 `init`이나 오프라인 계정 명령을 실행하지 마세요.
2. `secrets.json`과 SQLite를 **함께** 백업하세요. SQLite WAL 관련 파일까지 포함한 전체 데이터 디렉터리를 정지 상태에서 보관하는 것이 안전합니다. Docker에서는 `/data` 볼륨이 대상입니다.
3. 백업을 암호화하고 접근 권한을 제한하세요. 암호화된 DB만 저장해도 master key 없이 복구할 수 없고, master key가 함께 유출되면 자격 증명이 노출됩니다.
4. 같은 버전의 정지된 인스턴스에 전체 데이터 디렉터리를 복원하고 소유자·0700/0600 권한을 유지하세요. 원본과 복제본을 동시에 서비스하지 말고 localhost에서 먼저 확인하세요.

lock을 임의로 지우지 말고 실제 소유 프로세스를 확인하세요. 단일 프로세스 filesystem lock은 다중 호스트/replica 조정 수단이 아닙니다.

## 사고 대응과 릴리스 확인

유출된 client key는 revoke하고 다시 발급하세요. upstream 키·OAuth 토큰이 노출되면 Google에서도 폐기/회전한 뒤 새 자격 증명을 등록하세요. master key/admin token 또는 전체 호스트 유출은 데이터 디렉터리 전체 손상으로 취급하고, 호스트를 격리한 뒤 안전한 새 초기화 및 계정 재등록을 고려하세요. 토큰을 공개 issue에 붙이지 마세요.

요청 제한시간 기본 120초, 본문 16 MiB, bounded SSE/history와 계정 동시성 제한은 자원 소모를 줄이지만 인터넷 규모 DoS 보호나 사용자별 비용 상한을 보장하지 않습니다. 릴리스 전 type check, 테스트, build, formatting 외에 `npm audit`, secret review, 권한/백업 복구 확인을 수행하세요. 실제 Google 계정·billing 검증은 별도 운영자 자격 증명으로 필요합니다.
