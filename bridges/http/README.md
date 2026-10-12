# HTTP 브리지 (`bridges/http`)

설정한 HTTP 엔드포인트를 플러그인 메서드로 노출한다. 엔드포인트 하나가 메서드 하나다. 코드를 쓰지 않고 설정만으로 REST API를 me에 붙인다.

## 설정

`me.local.json`의 `pluginConfig.<플러그인 id>`에 적는다.

```json
{
  "baseUrl": "https://api.github.com",
  "headers": {
    "accept": "application/vnd.github+json",
    "authorization": { "file": "~/.config/me/secrets/github.token", "format": "Bearer {secret}" }
  },
  "maxBytes": 1048576,
  "endpoints": {
    "issue.get": {
      "url": "/repos/{owner}/{repo}/issues/{n}",
      "params": {
        "owner": { "type": "string", "required": true, "pattern": "^[\\w.-]+$" },
        "repo": { "type": "string", "required": true, "pattern": "^[\\w.-]+$" },
        "n": { "type": "number", "required": true }
      },
      "parse": "json"
    },
    "issue.comment": {
      "method": "POST",
      "url": "/repos/{owner}/{repo}/issues/{n}/comments",
      "params": { "owner": { "type": "string", "required": true }, "repo": { "type": "string", "required": true }, "n": { "type": "number", "required": true }, "text": { "type": "string", "required": true } },
      "body": { "body": "{text}" },
      "parse": "json",
      "failOnError": true
    }
  }
}
```

| 필드 | 뜻 |
|---|---|
| `baseUrl` | `url`이 `/`로 시작할 때 앞에 붙는다. 자리표시자를 쓸 수 없다. |
| `headers` | 모든 엔드포인트에 붙는 헤더. 엔드포인트의 같은 이름 헤더가 우선한다. |
| `maxBytes` | 응답 본문 상한(바이트). 기본 1 MiB, 최대 64 MiB. 엔드포인트별로도 줄 수 있다. |
| `endpoints.<메서드>.method` | `GET`(기본), `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `url` | 절대 http(s) URL이나 `/경로`. 자리표시자는 경로에만 쓸 수 있다. |
| `query` | `{ "이름": "{param}" }`. 없는 선택 파라미터를 쓰는 항목은 빠진다. |
| `params` | CLI 브리지와 같은 선언(`type`, `required`, `pattern`, `enum`, `default`). 선언하지 않은 파라미터는 거부한다. |
| `headers` | 값은 문자열 템플릿이나 비밀 헤더 `{ "file", "format"? }` |
| `body` | JSON 템플릿. 문자열 전체가 `"{n}"`이면 타입을 그대로 넣는다(숫자는 숫자). 맨 위가 문자열이면 텍스트로 보낸다. `GET`·`HEAD`에는 쓸 수 없다. |
| `parse` | `text`(기본) 또는 `json` |
| `timeoutMs` | 기본 25초. 넘으면 요청을 끊고 `-32003`. |
| `failOnError` | 2xx가 아니면 결과 대신 오류로 돌려준다. |

## 결과

```json
{ "status": 200, "ok": true, "contentType": "application/json", "body": { "...": "..." } }
```

- 2xx가 아니어도 결과다(`ok: false`). `failOnError`면 오류(`-32603`, `data`에 결과)가 된다.
- `parse: "json"`인데 본문이 JSON이 아니면, 2xx일 때만 오류다. 실패 응답의 HTML이나 텍스트는 그대로 돌려준다.
- 리다이렉트는 따라가지 않는다. 3xx는 `location`과 함께 결과로 돌려준다. 따라가면 비밀 헤더가 다른 서버로 갈 수 있기 때문이다.
- 응답 헤더는 `content-type`과 `location`만 돌려준다.

## 크기 상한

본문을 `maxBytes`까지만 읽고 나머지는 받지 않는다.

- `text`: 잘린 본문과 `truncated: true`를 돌려준다.
- `json`: 잘린 JSON은 해석할 수 없으므로 오류(`response exceeds maxBytes`)다.

## 보안 규칙

- **비밀은 파일 경로로만 받는다.** 비밀 헤더는 호출할 때마다 파일을 읽는다(키를 바꾸면 재시작 없이 반영된다). 앞뒤 공백을 지우고, 한 줄이 아니면 거부한다. 비밀 값은 결과, 오류, 로그 어디에도 넣지 않는다. 오류에는 헤더 이름과 파일 경로만 나온다.
- **호출자는 서버를 바꿀 수 없다.** 스킴, 호스트, 포트에는 자리표시자를 쓸 수 없고, 치환 뒤 origin이 바뀌면 거부한다.
- **경로 값은 한 조각으로 인코딩한다.** `encodeURIComponent`를 거치므로 `/`, `?`, `#`이 경로를 바꾸지 못한다. 값이 `.`이나 `..`이면 거부한다(URL 정규화로 다른 경로가 되기 때문).
- 헤더 값에 줄바꿈이 들어가면 거부한다.
- 매니페스트 권한은 `network` 하나다.

## 호출

```ts
await plugin.invoke("http-github", "issue.get", { owner: "o", repo: "r", n: 14 });
```

`op.cancel`(스트리밍 호출 취소)은 요청을 끊고 `-32004`로 끝난다.

## 매니페스트

`renderManifest(pluginId, config, bridgeMain)`이 만든다. `provides.methods`는 설정한 엔드포인트 이름과 같다.

```json
{ "run": { "command": ["bun", "../../bridges/http/src/main.ts"] }, "permissions": ["network"], "provides": { "methods": ["issue.get", "issue.comment"] } }
```

`me adapt`는 아직 이 브리지를 쓰지 않는다. 매니페스트와 설정은 직접 만든다.

## 테스트

`bun test bridges/http`. 임시 포트의 로컬 `Bun.serve`만 쓰고 네트워크는 쓰지 않는다.
