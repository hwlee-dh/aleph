# ALEPH API 명세

화면이 쓰는 HTTP API다.
경로는 전부 `/api` 아래다. 오류는 `{"error": "읽을 수 있는 말"}`과 4xx 상태로 온다. 본문이나 쿼리의 형식이 맞지 않을 때는 FastAPI의 422(`{"detail": [...]}`)가 온다. 오류와 안내의 글은 화면에 그대로 보여도 되는 말이고 '~습니다'로 끝난다. 도구 결과의 오류(`오류: …`)도 같다.
`GET /health` → `{status: "ok"}`. 서버가 떴는지 볼 때 쓴다.

## 1. 개념

작업(session) 하나에는 다음이 있다.

| 이름 | 경로 | 설명 |
| --- | --- | --- |
| 입력 | `입력` | 도구에 넘길 글. 하나뿐이다 |
| 출력 | `출력` | 도구가 낸 글. 하나뿐이다. 도구가 돌 때마다 덮인다 |
| 자료 | `자료/…` | 폴더를 쓸 수 있는 자유 문서. 글 문서(`.md`)와 이미지 등 파일 |
| 원고 | `원고/<장면 id>` | 장 아래 장면. 순서는 따로 관리되고 번호는 위치에서 나온다 |

- 글 문서의 경로는 확장자 없이 적어도 된다 (`자료/인물/서윤` = `자료/인물/서윤.md`).
- 장면 id는 `s1`, `s2`처럼 짧고, 한번 정해지면 바뀌지 않는다. 장 id는 `c1`, `c2`.
- **수정 방지**(`locked`)와 **노트**(`note`)는 문서·폴더·장·장면·원고 전체에 걸 수 있다. 폴더(또는 장, 원고 전체)에 걸면 안쪽에 적용되고, 더 안쪽에 직접 건 설정이 우선한다.
  - 수정 방지: 에이전트와 도구가 고치지 못한다. 사용자는 언제나 고칠 수 있다.
  - 노트: 에이전트의 컨텍스트에 항상 포함된다. 자료에만 건다.
- `@include:경로`: 입력 안에 적으면 도구가 돌 때 그 내용으로 바뀐다. `@include:자료/인물/서윤`, `@include:자료/인물`(폴더 전체), `@include:원고`(전체, 순서대로), `@include:원고/2장`(둘째 장), `@include:원고/s3`(장면), `@include:출력`. 비어 있는 원고·출력·폴더도 있는 것으로 본다 (`docs/resolve`가 `missing`이 아니고, 도구에는 "(원고: 비어 있음)"으로 들어간다).

## 2. 작업

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /sessions` | | `{sessions: [{id, name, created_at, updated_at, running, preset_id, chars, materials}]}` (`chars`는 원고 글자 수, `materials`는 자료의 수(글, 이미지, 파일을 다 센다). `updated_at`은 문서나 원고의 순서가 마지막으로 바뀐 때이고, 아직 바뀐 적이 없으면 만든 때다. 목록은 만든 순서(최근 것이 앞)로 오므로, 최근에 고친 순으로 보이려면 화면이 `updated_at`으로 줄 세운다. `preset_id`는 `state`와 같다: 쓰던 프리셋이 지워졌으면 지금 대신 쓰이는 것) |
| `POST /sessions` | `{name, preset_id?}` | `{id, name, created_at, preset_id}`. `preset_id`를 주지 않으면 그 작업의 이름으로 빈 프리셋을 만들어 붙인다. 새 작업에는 시작 자료 셋(`자료/작품 노트`, `자료/장기 계획`, `자료/단기 계획`. 제목 한 줄만 있고 전부 노트)이 깔린다. 프리셋과는 상관없다. 없는 프리셋이면 404 |
| `PATCH /sessions/{id}` | `{name}` | |
| `DELETE /sessions/{id}` | | 실행 중이면 409 |

### 작업의 상태

`GET /sessions/{id}/state`, `PUT /sessions/{id}/state` (준 것만 바뀐다)

```json
{
  "preset_id": "preset",
  "mode": "auto",            // manual | auto | autonomous | plan
  "bypass_locks": false,     // 권한 무시
  "auto_compact": true,      // 대화가 컨텍스트 한도를 넘으면 알아서 줄인다 (9.9). 채팅창의 원그래프에서 켜고 끈다
  "conversation": "main",    // 지금 보고 있는 대화 (9.11). 대화를 따로 적지 않은 요청은 여기로 간다
  "model": "anthropic:claude-…",            // 읽기 전용. 프리셋에 적힌 에이전트 모델 (쓸 수 없는 것이어도 그대로)
  "effective_model": "anthropic:claude-…"   // 읽기 전용. 실제로 쓰일 모델. 비었으면 골라야 한다
}
```

모델과 추론 수준은 작업의 상태가 아니다. 프리셋에 있고(5절), 채팅창에서 바꾸면 `PATCH /presets/{id}`로 프리셋을 고친다. 그래서 같은 프리셋을 쓰는 작업은 모델이 다 같이 바뀐다. `PUT …/state`에 `model`이나 `thinking`을 보내도 무시한다.

`effective_model`이 빈 문자열인 경우: 프리셋의 `model`이 비었다(새로 만든 프리셋은 비어 있다), 또는 적힌 모델의 제공자를 쓸 수 없다(등록되지 않았거나, 꺼져 있거나, 키나 주소가 없다). 화면은 채팅창에서 모델을 고르라고 알리면 된다. 그대로 요청을 보내면 400이다.

### 한 번에 받는 작업 공간

`GET /sessions/{id}/workspace` — 옆 패널들이 그릴 것 전부.

```json
{
  "state": { …위와 같음… },
  "input":  { "chars": 120, "updated_at": "…", "by": "agent" },
  "output": { "chars": 0, "updated_at": null, "by": "", "tool": "" },
  "materials": [
    { "path": "자료/인물/서윤.md", "kind": "text", "chars": 512, "size": 1290,
      "locked": false, "note": true, "updated_at": "…", "by": "agent" },
    { "path": "자료/삽화/등대.png", "kind": "image", "chars": 0, "size": 48211,
      "locked": false, "note": false, "updated_at": "…", "by": "user" }
  ],
  "folders": ["자료/인물", "자료/인물/조연", "자료/삽화"],
  "flags": { "자료/인물": { "locked": true }, "자료/계획.md": { "note": true }, "원고/c2": { "locked": true } },
  "manuscript": {
    "chars": 20411,
    "locked": false,
    "chapters": [
      { "id": "c1", "number": 1, "summary": "", "locked": false,
        "scenes": [
          { "id": "s3", "path": "원고/s3", "number": 1,
            "summary": "서윤이 폭풍 속에서 등탑에 올라 불을 켠다.",
            "summary_state": "ok",
            "head": "바람이 등탑의 창을 흔들었다.",
            "chars": 1204, "locked": false, "updated_at": "…", "by": "tool:compose" }
        ] }
    ]
  },
  "context": { "tokens": 18400, "budget": 150000 }
}
```

- `materials[].kind`: `text` | `image` | `file`. `chars`는 글 문서만.
- `folders`: 자료의 폴더 전부 (안쪽 폴더까지, 이름순). 문서가 든 폴더는 `materials`의 경로에서도 알 수 있지만, 빈 폴더는 여기에만 나온다. 폴더는 따로 저장하지 않고 문서의 경로에서 나오므로 안의 문서가 다 없어지면 폴더도 없어진다. 다만 사용자가 `POST …/docs/folders`로 만든 폴더는 비어도 남는다.
- `locked`·`note`는 상속까지 따진 실제 값이다. 직접 건 설정은 `flags`에 따로 있다 (없는 키는 "상속").
- `by`: 마지막으로 쓴 주체. `user` | `agent` | `tool:<도구 이름>` | `preset` | `""`.
- `summary_state`: `ok` | `stale`(본문이 바뀐 뒤 요약을 안 고침) | `manual`(사용자가 직접 씀, 자동으로 덮지 않음) | `none`.
- `context.tokens`: 마지막 요청에서 모델에 들어간 토큰 수. `budget`을 넘으면 대화 앞부분을 요약한다. 원 그래프는 `tokens / budget`.
- 에이전트가 문서를 바꾸면 실행 이벤트 `tool_result`가 온다. 그때와 `done`에서 이 경로를 다시 받으면 된다.

## 3. 문서 (입력, 출력, 자료, 장면 본문)

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /sessions/{id}/docs/content?path=` | | `{path, content, kind, locked, note}` |
| `PUT /sessions/{id}/docs/content` | `{path, content}` | `{path, created}`. 사용자의 쓰기는 수정 방지와 상관없이 된다 |
| `DELETE /sessions/{id}/docs/content?path=` | | 자료 문서나 폴더(안의 것 전부). `입력`·`출력`을 주면 비운다. 장면은 4절의 경로로 지운다 |
| `POST /sessions/{id}/docs/folders` | `{path}` | `{path}`. 자료에 빈 폴더를 만든다 (`자료/인물`, `자료/인물/조연`처럼 `자료/`로 시작하는 경로. 안쪽 폴더도 된다). 이미 있으면 그대로 둔다. 자료 밖이면 400 |
| `POST /sessions/{id}/docs/move` | `{source, destination}` | `{path}`. 자료 안에서 옮기기·이름 바꾸기, `출력`을 자료로 옮기기(출력은 비워진다). 폴더를 주면 폴더째 옮기고 `{path, moved: [...]}`를 돌려준다 (빈 폴더와 안에 든 폴더도 같이 간다. 빈 폴더면 `moved`가 빈 목록이다). 폴더를 다른 폴더 안으로 넣으려면 `destination`을 `그 폴더/이름`으로 준다. 자기 자신이나 자기 안쪽으로는 400. 걸려 있던 설정도 따라간다 |
| `PUT /sessions/{id}/flags` | `{path, locked?, note?}` | `{flags}`(바뀐 뒤의 전체). 값은 `true` \| `false` \| `null`(상속으로 되돌림). 본문에 든 것만 바뀐다. 경로는 `자료`, `자료/인물`, `자료/인물/서윤`, `원고`, `원고/c1`, `원고/s3` |
| `GET /sessions/{id}/docs/history?path=` | | `{entries: [...]}` 버전 기록 (아래) |
| `GET /sessions/{id}/docs/version?hash=` | | `{content}` |
| `POST /sessions/{id}/docs/restore` | `{path, hash}` | `{path}`. 예전 버전으로 복원. 지운 장면을 복원하면 원고 끝에 새 장면으로 들어가고 그 새 경로가 온다 |
| `GET /sessions/{id}/deleted` | | `{items: [{path, kind, deleted_at, by, hash, chars, head}]}`. 지워진 채로 있는 글 문서와 장면, 최근에 지운 것부터 |
| `GET /sessions/{id}/docs/resolve?ref=` | | `@include`의 대상. `{kind: "doc"\|"folder"\|"scene"\|"chapter"\|"manuscript"\|"missing", path, title}` |

지운 것의 목록(`/deleted`): 누가 지웠든(나, 에이전트) 나온다. `kind`는 `scene` | `doc`, `head`는 글의 첫 줄(무엇인지는 이것으로 알아본다), `hash`는 `docs/restore`에 넘길 버전이다. 복원한 것, 같은 경로에 다시 생긴 것, 합쳐져 없어진 장면, 빈 채로 지운 것은 나오지 않는다. 이미지 같은 파일은 지우면 복원할 수 없어서 나오지 않는다.

버전 기록의 한 줄:

```json
{ "seq": 12, "timestamp": "…", "action": "write", "path": "원고/s3", "to": null,
  "by": "tool:compose", "hash": "…", "prev_hash": "…", "chars": 1204,
  "origin": { "tool_call_id": "…", "model": "…" },
  "tool_run": { "tool": "compose", "label": "집필", "model": "…", "duration_ms": 8200, "run_seq": 4 },
  "proposal": { "id": "…", "status": "accepted", "note": "" } }
```

`action`: `write` | `delete` | `move`. `tool_run`은 도구가 쓴 줄에만 있고, `run_seq`로 5절의 도구 실행 기록(그때의 입력 전문)을 찾을 수 있다.
지워진 문서나 장면의 경로를 줘도 기록이 온다. `origin`에는 그 변경이 어디서 비롯했는지가 들어 있다 (`uploaded`: 올린 파일 이름, `from_output`: 출력에서 가져옴, `split_from`·`merged`: 나누기·합치기, `restored_from`: 복원한 버전).

### 파일

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /sessions/{id}/files?path=` | | 파일 바이트 (이미지 표시용). `Content-Type`이 붙는다. 경로에 띄어쓰기가 있어도 되고, 원고에 `등대%20그림.png`처럼 적힌 것도 찾는다 |
| `POST /sessions/{id}/upload?name=<파일 이름>&folder=<자료 아래 폴더>` | 파일 바이트 그대로 (multipart 아님) | 아래 |

올리기의 응답:

```json
{ "path": "자료/올린 글/등대지기의 딸", "kind": "text", "chars": 48211, "note": "" }
```

- `.txt` `.md` `.docx` `.hwpx` `.pdf`: 서버가 텍스트를 뽑아 글 문서로 넣는다. 통짜 문서 하나다. 나누는 것은 에이전트에게 시킨다.
- 이미지(`.png` `.jpg` `.jpeg` `.webp` `.gif`): 파일 그대로 넣는다. `kind: "image"`.
- 글을 뽑지 못하면(옛 `.hwp`, 받지 않는 형식, 빈 문서, 깨진 파일) 422와 이유를 돌려준다. 아무것도 저장하지 않는다. 글이 없는 PDF(스캔한 문서)는 파일 그대로 자료에 넣는다 (9.7). 빈 파일은 400, 40MB를 넘으면 413.
- 본문은 파일 바이트 그대로다: `fetch(url, {method: "POST", body: file})`.
- `folder`를 안 주면 글은 `자료/올린 글`, 이미지는 `자료/삽화`.
- 같은 이름이 있으면 뒤에 번호를 붙인다.

## 4. 원고

읽기는 2절의 `workspace.manuscript`로 한다. 장면 본문은 3절의 문서 경로(`원고/s3`)로 읽고 쓴다.

장과 장면에 제목은 없다. 목록에서 장면을 알아보는 머리는 요약이고, 사람에게 보일 이름은 자리다 (`1장 3번째 장면`). 요약이 아직 없는 장면은 `head`(본문의 첫 줄, 80자까지)를 대신 보이면 된다. 글에 제목이 필요하면 본문에 글로 적는다.

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `POST /sessions/{id}/manuscript/scenes` | `{content?, from_output?, chapter?, after?, new_chapter?}` | `{id, path, chapter}` |
| `PATCH /sessions/{id}/manuscript/scenes/{scene}` | `{summary?}` | 요약을 직접 주면 `manual`이 된다. `summary: null`이면 자동으로 되돌린다 |
| `POST /sessions/{id}/manuscript/scenes/{scene}/move` | `{chapter, after, new_chapter?}` | 순서 바꾸기. `{status, chapter}`(옮겨 간 장) |
| `POST /sessions/{id}/manuscript/scenes/{scene}/split` | `{at: [글자 위치…]}` | `{ids: [...]}`. 그 위치에서 자른다. 첫 조각이 원래 id를 갖는다 |
| `POST /sessions/{id}/manuscript/merge` | `{scenes: [id, id…]}` | `{id}`. 적힌 순서대로 첫 장면에 합친다 |
| `DELETE /sessions/{id}/manuscript/scenes/{scene}` | | 버전 기록에서 복원할 수 있다 |
| `POST /sessions/{id}/manuscript/chapters` | `{after?}` | `{id}`. 빈 장을 만든다 |
| `PATCH /sessions/{id}/manuscript/chapters/{chapter}` | `{summary?}` | |
| `POST /sessions/{id}/manuscript/chapters/{chapter}/move` | `{after}` | 장 순서 바꾸기 |
| `DELETE /sessions/{id}/manuscript/chapters/{chapter}` | | 장면이 있으면 409 |

- 장면을 넣을 자리: `chapter`(장 id, 안 주면 마지막 장), `after`(그 장면 뒤, `null`이면 장의 맨 앞, 안 주면 장의 맨 끝), `new_chapter: true`면 새 장을 만들어 거기 넣는다.
- `from_output: true`면 본문을 출력에서 가져오고 출력을 비운다. 출력이 비어 있으면 400.
- `content`를 안 주면 빈 장면이 생긴다 (화면의 `+ 장면`. 거기에 직접 쓴다). 빈 장면에는 요약이 붙지 않는다.
- 요약은 저절로 생기지 않는다. 요약은 에이전트가 붙이거나(요약 도구를 돌려서, 또는 직접 적어서) 사용자가 직접 쓴다(`PATCH …/scenes/{scene}`의 `summary`).
- `summary_state`: `none`(요약이 없다) | `ok` | `stale`(요약을 붙인 뒤에 본문이 바뀌었다) | `manual`(사용자가 직접 썼다. 에이전트와 도구가 덮지 않는다). 화면은 `stale`을 낡았다고 표시한다. 사용자가 고친 장면은 에이전트가 요약을 다시 붙일 때까지 `stale`로 남는다. 요약을 다시 붙이려면 에이전트에게 시키면 된다 ("요약을 다시 붙여 줘").

### 내보내기

`GET /sessions/{id}/export?format=md|txt|html|zip&chapters=true|false` — 파일로 내려온다 (`Content-Disposition`).

본문에 적힌 마크다운 표시: `md`와 `zip`에는 적힌 그대로 나간다. `html`에서는 `**굵게**`가 `<strong>`, `*기울임*`이 `<em>`, `#` 줄이 제목, `***`만 있는 문단이 `<hr>`이 된다. `txt`에서는 굵게·기울임의 표시와 제목 줄의 `#`이 떨어진다. 표시 바로 안쪽이 빈칸인 별표(`2 * 3`)와 짝이 안 맞는 별표는 건드리지 않는다.

장이 둘 이상이면 장마다 번호(`1장`, `2장`)가 머리로 들어간다. `chapters=false`면 넣지 않는다 (본문에 제목을 직접 적은 사람을 위한 것. 안 주면 true). 장면 사이는 빈 줄 하나다.

| 형식 | 내용 |
| --- | --- |
| `txt` | 글만. 이미지는 `[그림: 설명]`으로 바뀐다 |
| `md` | 마크다운 한 파일. 이미지는 경로만 남는다 |
| `html` | 이미지를 안에 품은 HTML 한 파일 |
| `zip` | 마크다운 + 이미지 폴더 |

원고의 이미지는 `![설명](자료/삽화/등대 그림.png)`처럼 적는다. 경로에 띄어쓰기가 있어도 내보내기에 그대로 들어간다.

## 5. 프리셋과 도구

프리셋은 지침, 모델 설정, 도구 한 벌이다. 화면에서 고치면 바로 저장한다(자동 저장). 프리셋은 그것을 쓰는 모든 작업이 공유한다.

앱에 같이 들어 있는 프리셋은 없다. 프리셋은 전부 사용자가 만들거나 가져온 것이고, 처음 켠 앱의 목록은 비어 있다.

모델 설정은 프리셋에만 있다. 프리셋을 내보내면 모델 설정도 같이 간다.

```ts
interface Preset {
  id: string;
  name: string;
  description: string;
  instruction: string;        // 에이전트 지침
  tools: ToolDef[];
  // 에이전트
  model: string;              // '제공자:모델'. 비면 실행할 수 없다 (채팅창에서 고르면 여기에 적힌다)
  temperature: number | null; // null이면 모델의 기본값 (아래의 null도 같다)
  thinking: "default" | "off" | "low" | "medium" | "high";
  max_output_tokens: number | null;
  context_budget: number;     // 대화가 이 토큰 수를 넘으면 앞부분을 줄인다. 기본 150000. 0이면 줄이지 않는다
  // 보조: 도구가 따로 정하지 않았을 때 쓰는 값. 대화 압축도 이 모델로 한다
  auxiliary_model: string;    // 비면 에이전트 모델과 같다 (화면의 `에이전트 모델과 같게`)
  auxiliary_temperature: number | null;
  auxiliary_thinking: "default" | "off" | "low" | "medium" | "high";
  auxiliary_max_output_tokens: number | null;
  auxiliary_max_input_tokens: number | null;   // 도구에 넘기는 글이 이것을 넘으면 돌리지 않고 오류로 알린다 (자르지 않는다)
  image_model: string;        // 그림을 만드는 모델 (9.12). 비면 에이전트가 그림을 만들지 않는다
  start_mode: "" | "manual" | "auto" | "autonomous" | "plan";   // 이 프리셋으로 새 작업을 만들 때의 모드 (9.13). 비면 앱의 기본값(auto)
  web_search: boolean; web_fetch: boolean;   // 제공자가 실행하는 도구 (9.7)
}

interface ToolDef {
  name: string;     // 영문 id (a-z, 0-9, _). 비워 보내면 서버가 정한다. 모델이 부르는 함수 이름이다
  label: string;    // 화면에 보이는 이름. `/집필`의 그 이름
  description: string;   // 에이전트가 읽는 설명 (언제, 무엇을 입력에 준비해 두고 부르는지)
  prompt: string;   // 지시문. 도구가 불렸을 때 모델이 따른다
  // 아래 넷은 비우면 프리셋의 보조 값을 따른다
  model: string;                // ""이면 보조 모델 (화면의 선택지 이름은 `보조 모델`)
  temperature: number | null;   // null이면 보조의 온도
  thinking: "" | "default" | "off" | "low" | "medium" | "high";   // ""이면 보조의 추론 수준. "default"는 모델의 기본값
  max_tokens: number | null;    // 최대 출력. null이면 보조의 최대 출력
  enabled: boolean;
}
```

숫자 칸은 서버가 쓸 수 있는 범위로 맞춘다: 온도는 0~2, 한도(`max_output_tokens` 등)에 0이나 음수를 보내면 `null`(정하지 않음)이 된다.

`PUT`은 모르는 칸을 무시한다.

도구는 언제나 입력을 읽고 출력에 쓴다. 입력·출력 위치를 설정하는 값은 없다.

- 화면이 고치는 족족 저장할 수 있게, 쓰다 만 상태도 받는다: 지시문이 빈 도구, 보이는 이름이 같은 도구. 지시문이 빈 도구는 에이전트에게 주지 않고, `/도구`로 돌리려 하면 400으로 이유를 알려 준다.
- `name`은 화면이 임시로 지어 보내도 된다 (`tool_a1b2c3`처럼 소문자·숫자·`_`, 2~49자). 서버는 받은 이름을 그대로 둔다. 한 프리셋 안에서 `name`이 겹치면 400.
- 작업이 쓰던 프리셋을 지우면 그 작업은 남은 프리셋 가운데 첫째(id순)로 넘어간다. 남은 것이 없으면 `state.preset_id`가 빈 문자열이고, 요청을 보내면 400이다.

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /presets` | | `{presets: [{id, name, description}]}` |
| `POST /presets` | `{name?}` | 새 `Preset`. 빈 프리셋이다 (지침도 도구도 모델도 없다). 이름을 주지 않으면 `새 프리셋`이고, 같은 이름이 있으면 뒤에 번호가 붙는다 |
| `GET /presets/{id}` | | `Preset` |
| `PUT /presets/{id}` | `Preset` | 저장된 `Preset`. 없는 id면 그 id로 새로 만든다 |
| `PATCH /presets/{id}` | 고칠 칸만 (`{model: "…"}`) | 저장된 `Preset`. 준 칸만 바뀌고 나머지는 서버에 있는 그대로다. 채팅창에서 모델·추론 수준을 바꿀 때 쓴다 (에이전트 패널이 자동 저장하는 다른 칸을 덮지 않게). `id`나 모르는 칸을 보내면 400 |
| `DELETE /presets/{id}` | | `{status: "deleted"}`. 없는 프리셋이면 404 |
| `POST /presets/{id}/duplicate` | `{name?}` | 새 `Preset` (복제, 다른 이름으로 저장). 이름을 안 주면 `… 사본`, 이미 있으면 `… 사본 2` |

파일로 내보내고 가져오는 것은 9.3에 있다 (`GET /presets/{id}/archive`, `POST /import`).

### 도구 실행 기록

`GET /sessions/{id}/tool-runs` — 이전 입력·출력을 다시 볼 때 쓴다. 최신이 뒤.

```json
{ "runs": [ { "seq": 4, "timestamp": "…", "tool": "compose", "label": "집필", "by": "agent",
              "model": "…", "duration_ms": 8200, "input": "…도구에 실제로 들어간 글(@include가 풀린 뒤)…",
              "input_raw": "…입력에 적혀 있던 그대로…", "output": "…", "error": null, "target": null } ] }
```

`target`: 묶음 요약(`summarize_scenes`)이 돌린 것이면 그 장면이나 장의 경로(`원고/s3`, `원고/c1`), 아니면 null. 묶음 요약은 장면마다 한 줄씩 남는다. 입력과 출력 자리를 거치지 않으므로 `input_raw`는 `@include:원고/s3` 꼴이다. 화면은 `target`이 있는 것들을 한 묶음으로 접어 보이면 된다 (같은 `tool_call_id`).

`by`: `agent`(에이전트가 부름) | `user`(사용자가 직접 돌림).

## 6. 실행

### 에이전트에게 보내기

`POST /sessions/{id}/runs` `{goal, tool?, conversation?}` → `{run_id, conversation_id}`

- 모드, 모델, 프리셋, 권한 무시는 작업의 상태(2절)에서 읽는다. 보내기 전에 상태를 저장해 둔다.
- `tool`(도구의 `name`)을 주면 "이 도구를 쓰라고 사용자가 지정했다"는 뜻이다. `/집필 문체에 주의해줘`가 이것이다. 에이전트가 `goal`을 반영해 입력을 준비한 뒤 그 도구를 돌린다.
- `conversation`을 주면 그 대화에서, 안 주면 지금 보고 있는 대화에서 돈다 (9.11). 없는 대화면 404.
- 실행 중이면 409 (다른 대화에서 돌고 있어도). 프리셋에 모델이 없거나 제공자가 준비되지 않았으면 400.

### 도구를 직접 돌리기

`POST /sessions/{id}/tools/{name}/run` → `{run_id, conversation_id}`

- 에이전트를 거치지 않고 지금 입력으로 도구를 돌려 출력에 쓴다. `/집필`만 보낸 경우다.
- 입력이 비어 있으면 400. 실행 중이면 409.
- 이벤트는 같은 흐름으로 온다 (`run_started`의 `kind`가 `tool`).

### 그 밖

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /sessions/{id}/events?conversation=` | | `{conversation_id, events: [...], run: {running, run_id, conversation_id, status?, waiting_for_user?}}`. 대화 하나의 기록 (9.11). `status`와 `waiting_for_user`는 서버가 켜진 뒤로 그 작업에서 실행이 돈 적이 있을 때만 온다. `conversation`을 안 주면 지금 보고 있는 대화 |
| `GET /sessions/{id}/stream?after=<seq>` | | SSE. `data: <이벤트 JSON>` 줄들, 끝나면 `data: [DONE]` |
| `POST /sessions/{id}/respond` | `{event_id, response}` | 질문·확인에 답하기 |
| `POST /sessions/{id}/stop` | | `{stopped}` |
| `POST /sessions/{id}/conversation/compact` | | 대화를 지금 줄인다 (9.9). 실행 중이면 409 |
| `GET /sessions/{id}/process-log` | | `{content, session_name}` 제작 기록 (마크다운) |

### 모드

| id | 이름 | 동작 |
| --- | --- | --- |
| `manual` | 수동 | 문서를 바꾸거나 도구를 돌리기 전에 항상 확인한다. 읽기는 그냥 한다 |
| `auto` | 자동 | 에이전트가 판단해서 확인을 청한다. 원고 변경은 항상 확인한다 |
| `autonomous` | 자율 | 확인하지 않는다. 사용자에게 질문도 하지 않는다 |
| `plan` | 계획 | 읽기와 자료 쓰기만 한다. 도구 실행과 원고 변경은 하지 못한다 |

### 이벤트

공통: `{type, seq, run_id, conversation_id, timestamp}`.

| type | 값 |
| --- | --- |
| `run_started` | `kind`: `agent` \| `tool`, `mode`, `agent_model`, `preset_name`, `bypass_locks` |
| `user_message` | `text`, `tool?`·`tool_label?`(지정한 도구의 영문 이름과 보이는 이름), `in_reply_to?`(질문에 대한 답이면 그 `event_id`) |
| `text_delta` / `text` | `id`, `delta` / `text` — 에이전트의 말 |
| `thinking_delta` / `thinking` | `id`, `delta` / `text` |
| `tool_call` | `tool`, `label`, `tool_call_id`, `args`, `tool_call_index`(이 실행에서 몇 번째 도구 호출인지. 한도는 없다), `user_tool`(사용자가 만든 도구면 true), `direct?`(사용자가 직접 돌린 것이면 true) |
| `tool_stream` | `tool`, `tool_call_id`, `delta` — 도구 안에서 모델이 쓰고 있는 글 |
| `tool_result` | `tool`, `label`, `tool_call_id`, `result`, `ok`, `changed`(바뀐 경로들. `입력`, `출력`, `자료/…`. 원고가 바뀌었으면 `원고`와 바뀐 장면들 `원고/s3`이 같이 온다. 지워진 장면도 온다), `direct?`, `rejected?`(사용자가 확인에서 반려해 하지 않은 호출이면 true) |
| `user_input_required` | 아래 |
| `user_input_resolved` | `event_id` (답의 내용은 바로 앞의 `user_message`에 있다) |
| `compaction` | `kind`: `cleared` \| `summary`, `cleared_results`, `dropped_messages`, `kept_messages`, `tokens_before`, `tokens_after`, `summary`, `manual?` (9.9) |
| `notice` | `level`, `text` |
| `error` | `error` |
| `done` | `status`: `completed` \| `stopped` \| `stalled` \| `interrupted` \| `error`, `total_tool_calls`, `elapsed_sec`, `usage`: `{agent_model, prompt_tokens, output_tokens, cache_read_tokens, cost_usd, context_tokens}` |

`user_input_required`의 `kind`:

- `question` — 에이전트의 질문. `question`, `options`(없을 수 있음). 답은 자유로운 글.
- `proposal` — 문서 변경 확인. 값:
  - `action`: `write`(고치기·새로 쓰기) | `delete` | `move` | `insert`(원고에 장면 넣기) | `split` | `merge` | `reorder`
  - `path`, `dest`(옮길 곳), `old`(바뀌기 전 글, 없으면 null), `new`(바뀐 뒤 글), `description`(한 줄 설명), `by`
  - `insert`: `new`에 넣을 글, `position`에 `{chapter, after, end, new_chapter}` (`chapter`는 장 id 또는 null, `after`는 장면 id 또는 null, `end`가 true면 장의 끝).
  - `split`: `pieces`에 `[{chars, head, new_chapter}]` (`head`는 조각의 첫 줄). `path`가 자료 문서면 그 글을 잘라 원고에 넣는 것이다.
  - `merge`: `scenes`에 합칠 장면 경로들, `old`에 첫 장면의 지금 글, `new`에 합친 글.
  - `reorder`: `path`에 옮길 장면, `position`에 옮길 자리.
  - 원고의 장면을 고치는 것은 `write`로 오고 `path`가 `원고/s3`이다.
- `tool_confirm` — 도구 실행 확인. `tool`, `label`, `input`(도구에 들어갈 글, `@include`가 풀린 뒤).

`done`의 `status`가 `stalled`인 것은 에이전트가 헛돌아서 엔진이 멈춘 것이다: 같은 도구를 같은 인자로 10번 연달아 불렀거나, 최근 30번의 호출이 세 가지 이하의 호출만 번갈아 되풀이한 것일 때 (바로 앞에 `error` 이벤트가 온다). `interrupted`는 실행 도중에 서버가 꺼져서(창을 닫았거나 컴퓨터가 꺼졌다) 끝을 맺지 못한 실행이다. 엔진이 다음에 켜질 때 그 대화의 기록 끝에 `{type: "done", status: "interrupted", run_id, conversation_id}`를 붙인다 (`seq`, `usage` 등은 없다). 그 실행이 문서에 남긴 변경은 그대로 있고, 에이전트는 그 실행을 기억하지 못한다. 화면은 `서버가 꺼져서 끊김` 정도로 보이면 된다.

`tool_confirm`은 묶음 요약(`summarize_scenes`)에도 온다 (수동 모드에서). 그때 `input`은 요약을 붙일 곳의 이름들이다 (한 줄에 하나, `1장 2번째 장면`).

`proposal`과 `tool_confirm`의 답: `승인` 또는 `반려`. 그 밖의 글을 보내면 그것을 사유로 한 반려다. `options`에 `["승인", "반려"]`가 온다.

수동 모드에서 입력을 쓰는 것은 확인하지 않는다 (도구를 돌리기 전 `tool_confirm`에서 입력이 통째로 보인다).

### 문서에서 인용해 요청하기

따로 경로가 없다. 요청 글에 인용을 넣어 `runs`로 보낸다. 형식은 화면이 정하면 되지만, 시연 서버의 가짜 에이전트는 이 형식을 알아본다.

```
[인용: 원고/s1]
> 인용한 대목의 첫 줄
> 둘째 줄

요청하는 말
```

## 7. 설정과 제공자

- `GET /meta` — `version`(앱의 버전 번호, `"0.4.0"` 꼴. `backend/pyproject.toml`의 값이다), `version_date`(그 번호를 올린 날, `"2026-11-17"` 꼴. 같은 파일의 `[tool.aleph] date`. 없으면 빈 문자열), `provider_kinds`, `modes: [{id, label, description}]`, `agent_tools: [{name, label}]`(에이전트의 기본 도구. 실행 이벤트에도 `label`이 오므로 보통은 그것을 쓰면 된다), `summary_tool`(요약 도구의 기본 꼴인 `ToolDef`. 사용자가 지운 요약 도구를 `+ 도구`에서 다시 넣을 때 이것을 채워 넣는다).
  - 앱이 지침 앞에 붙이는 글은 화면에 보이지 않는다 (제작 기록에는 남는다).
- 모델 설정은 전부 프리셋에 있다 (5절). 앱 설정에 있는 것은 제공자와 화면 설정(`/appearance`, `/fonts`. 9.8)이다.
- `GET /providers`, `PUT /providers/{id}`, `DELETE /providers/{id}`, `DELETE /providers/{id}/key`, `GET /providers/{id}/models`. 저장해도 목록에서의 자리는 바뀌지 않는다.

## 8. 시연 서버

키 없이 화면을 둘러볼 때 쓴다. 데이터는 `data-demo/`에 따로 쌓인다.

```bash
cd backend && uv run python scripts/demo_server.py 8765            # 같이 들어 있는 작업 하나를 띄운다 (demo.bat)
cd backend && uv run python scripts/demo_server.py 8765 --fake     # 가짜 모델이 대본대로 움직인다
```

그냥 켜면 `backend/scripts/demo/aleph-demo.aleph`(실제 모델로 진행한 작업)를 시연 데이터에 넣는다 (한 번만). 모델은 연결돼 있지 않다.
화면은 주소의 `?work=<작업 id>`를 보고 그 작업을 바로 연다.

같은 작업을 서버 없이 볼 수 있는 정적 사이트로 뽑을 수도 있다 (`scripts/make_static_demo.py`). 화면을 `vite build --mode static`으로 빌드하고,
화면이 읽는 `GET` 응답을 미리 받아 `snapshot/`에 파일로 둔다. 그 화면은 읽기 전용이다 (`PUT …/state`만 받아서 그 탭에서 기억한다).

`--fake`의 가짜 에이전트가 하는 일은 `backend/scripts/demo_server.py` 맨 위에 적혀 있다. 요약하면:

| 하는 일 | 가짜 에이전트의 반응 |
| --- | --- |
| 계획 모드에서 요청 | 자료에 계획을 쓰고 노트로 지정한 뒤 질문 하나 |
| 원고가 비어 있을 때 요청 (자동·수동) | 시점을 묻고 → 자료와 입력을 쓰고 → 집필(자동 모드에서는 실행 확인) → 원고에 넣기(확인) |
| 원고가 비어 있을 때 요청 (자율) | 묻지 않고 두 장면. 둘째 장면은 비평을 거친다 |
| 원고가 있을 때 요청 | 다음 장면 |
| 글을 올린 뒤 "장면으로 나눠 줘" | 올린 글을 읽고 나눈다 (확인) |
| 인용해서 요청 | 그 대목의 마지막 문장을 덜어낸다 (원고면 확인) |
| `/도구 요청` | 요청을 입력에 덧붙이고 그 도구를 돌린다 |
| 확인을 반려 | 거기서 멈춘다 |
| 원고가 비어 있을 때의 첫 단계 | 생각(`thinking`)이 먼저 보인다 |
| 프리셋에서 웹 검색을 켜고 "…찾아봐 줘" | 검색하는 시늉(`native: true`인 `web_search` 호출과 결과)을 하고 자료에 조사 메모를 남긴다 |
| "'서윤'을 '서연'으로 바꿔 줘" (따옴표로 두 글귀) | 찾기 → 찾아 바꾸기 (원고가 들어 있으면 `replace` 확인) |
| 자료에 이미지나 PDF가 있고 "삽화를 봐 줘" | 파일 보기 |
| 실행 중에 말 걸기 | 하던 대본을 끝까지 하고, 받았다고 답한다 |
| "요약"이라는 말이 든 요청 (원고에 장면이 있을 때) | 요약이 없거나 낡은 장면에 요약 도구를 한꺼번에 돌린다 (`summarize_scenes`) |
| 장면에 "요약 실패"라고 적혀 있음 | 그 장면의 요약이 일부러 실패한다. 묶음 요약의 결과(`tool_result`)에 실패한 곳이 적혀 온다 |

`--fake`로 켠 시연 서버에는 시연용 프리셋 `demo`(이름 `시연`. 집필, 비평, 요약 도구)가 들어 있다 (시연 데이터에 프리셋이 하나도 없을 때 만든다). 프리셋의 모델을 고르지 않아도 된다 (모델이 빈 프리셋은 가짜 모델 `demo:agent`로 읽힌다). 장면을 넣는 대본은 끝에 묶음 요약을 한 번 돌린다.

자동 대화 압축은 시연 서버에서 일어나지 않는다 (대화가 한도까지 길어지지 않는다). `지금 압축`(`POST …/conversation/compact`)은 된다. 이벤트의 모양은 9.9에 있다.


## 9. 그 밖의 기능

### 9.1 요청 단위로 되돌리기

에이전트(또는 직접 돌린 도구)가 요청 하나에서 바꾼 것을 한 번에 되돌린다. **가장 최근의 실행만** 되돌릴 수 있다.

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /sessions/{id}/runs/last` | | 아래 |
| `POST /sessions/{id}/runs/{run_id}/revert` | `{force?}` | `{reverted: [경로…], kept: [경로…]}` |

`runs/last`의 응답:

```json
{ "run_id": "…", "kind": "agent", "goal": "첫 장면을 써줘", "status": "completed",
  "revertible": true, "reason": "",
  "changes": [ {"path": "자료/인물/서윤", "action": "write", "title": "인물/서윤"},
               {"path": "원고/s1", "action": "write", "title": "1장 1번째 장면"},
               {"path": "출력", "action": "write", "title": "출력"} ],
  "touched_later": ["자료/인물/서윤"] }
```

- 실행이 없으면 `{run_id: null, revertible: false, …}`.
- `changes`의 `title`: 사람이 알아볼 이름. 장면은 자리(`1장 1번째 장면`), 그 실행이 지워서 지금은 없는 장면은 "지운 장면", 자료는 `자료/`를 뗀 이름(`인물/서윤`), 순서만 바뀐 경우는 "원고의 순서".
- `revertible`이 false인 경우와 `reason`: 실행 중이다, 이미 되돌렸다, 바꾼 것이 없다, 되돌릴 기록이 없다.
- `changes`의 `action`: `write`(새로 쓰거나 고침) | `delete` | `move`. 같은 문서는 한 번만 나온다. 글은 그대로고 원고의 순서만 바뀐 실행이면 `{path: "원고", action: "structure"}` 하나가 온다.
- `touched_later`: 그 실행이 바꾼 문서 가운데, 그 뒤에 사용자가 직접 고친 것. 이것이 있으면 `revert`는 409와 함께 `{error, touched_later}`를 돌려준다. `force: true`로 보내면 그 문서들은 사용자가 고친 대로 두고(`kept`) 나머지만 되돌린다.
- 되돌리면: 문서가 실행 전의 내용으로 돌아가고(새로 생긴 것은 그 실행이 만든 그림까지 없어지고, 지워진 것은 돌아온다), 원고의 순서·요약과 수정 방지·노트 설정도 실행 전으로 돌아가고, 에이전트의 대화 기억에서도 그 요청이 빠진다. 대화 기록(`events`)은 지우지 않고, 맨 끝에 아래 이벤트가 붙는다.

```json
{ "type": "reverted", "target_run_id": "…", "reverted": ["자료/인물/서윤", "원고/s1"], "kept": [] }
```

화면은 그 실행의 항목들을 "되돌림"으로 흐리게 보이면 된다. 되돌린 문서들의 버전 기록에는 `by: "user"`, `origin.reverted_run`으로 남는다.

### 9.2 실행 중에 말 걸기

`POST /sessions/{id}/steer` `{text}` → `{status: "queued"}`. 실행 중이 아니면 409 (그때는 `runs`로 보내면 된다).

`user_message{steer: true}`는 **받은 즉시** 흐름에 나온다 (에이전트에게 전달될 때가 아니다). 그 실행의 `run_id`가 붙는다.

중단하지 않고 에이전트에게 말을 끼워 넣는다. 에이전트가 다음에 모델을 부를 때(보통 지금 하던 도구 호출이 끝난 직후) 전달된다. 끝나려던 참이었으면 그 말을 받고 이어서 한다. 흐름에는 이렇게 보인다.

```json
{ "type": "user_message", "text": "시점은 아버지로 해줘", "steer": true }
```

질문이나 확인을 기다리는 중에 보내면 그 답이 아니라 따로 전달된다 (답은 `respond`).

### 9.3 파일로 내보내기·가져오기: `.aleph`, `.alephpreset`

작업은 `.aleph`, 프리셋은 `.alephpreset` 파일 하나로 나간다. 둘 다 속은 zip이다 (확장자를 `.zip`으로 바꾸면 열린다).

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /sessions/{id}/archive` | | 파일 (`<작업 이름>.aleph`). 문서, 원고, 버전 기록, 대화, 도구 실행 기록, 쓰던 프리셋이 들어 있다. 실행 중이면 409 |
| `GET /presets/{id}/archive` | | 파일 (`<프리셋 이름>.alephpreset`). 지침, 도구, 설정 |
| `POST /import` | 파일 바이트 그대로 | 파일의 종류에 따라 아래 둘 중 하나 |

응답의 `Content-Type`은 `application/octet-stream`, 파일 이름은 `Content-Disposition`의 `filename*`에 있다.

```ts
// POST /import의 응답
type Imported =
  | { kind: "work"; id: string; name: string; preset_id: string }   // 새 작업으로 들어왔다
  | { kind: "preset"; preset: Preset };                             // 새 프리셋으로 들어왔다
```

- 가져오기는 한 곳이다. 서버가 파일 안을 보고 작업인지 프리셋인지 가린다. 작업을 가져오는 자리에 프리셋 파일을 넣어도(반대도) 들어오고, 화면은 `kind`를 보고 무엇이 들어왔는지 알려 주면 된다. 파일 선택창은 `accept=".aleph,.alephpreset"`.
- 작업: 같은 이름이 이미 있으면 `… (가져옴)`, 그것도 있으면 `… (가져옴) 2`. 그 작업이 쓰던 프리셋이 이 컴퓨터에 없으면 프리셋도 같이 들어온다. 같은 id의 프리셋이 이미 있으면 있는 것을 쓴다.
- 프리셋: 언제나 새 id로 들어온다 (있던 것을 덮어쓰지 않는다). 같은 이름이 있으면 `… 2`.
- ALEPH에서 내보낸 파일이 아니거나 읽을 수 없으면 400 (`error`에 이유).

파일 안의 모양 (사람이 열어서 고쳐도 된다):

```
<이름>.alephpreset
  aleph.json            {app: "ALEPH", kind: "preset", format: 1, name, id, exported_at}
  preset.yaml           이름, 설명, 에이전트와 보조의 모델·온도·추론·한도, 도구 순서 …
  instruction.md        에이전트 지침
  tools/<name>.md       도구 하나가 파일 하나 (머리말 + 지시문)

<이름>.aleph
  aleph.json            {app: "ALEPH", kind: "work", format: 1, name, preset_id, exported_at}
  preset/…              쓰던 프리셋 (위와 같은 모양)
  session/…             작업 폴더 그대로
```

### 9.4 같은 입력으로 비교하기

`POST /sessions/{id}/tools/{name}/run`에 본문을 줄 수 있다 (안 주면 직접 실행).

```json
{ "trial": true, "input_seq": 4, "model": "google:gemini-…" }
```

- `trial: true`: 시험 실행. 출력을 건드리지 않고, 결과는 도구 실행 기록에만 남는다.
- `input_seq`: 그 번호의 도구 실행에 들어갔던 입력을 그대로 다시 쓴다. 안 주면 지금의 입력.
- `model`: 이번에만 쓸 모델. 안 주면 그 도구의 모델. 쓸 수 없는 모델이면 400.
- `input_seq`의 실행이 없으면 404. 시험 실행의 결과를 다시 `input_seq`로 주면 `base_seq`는 맨 처음 실행의 번호가 된다 (같은 입력끼리 묶기 쉽게).
- `run_started`에도 `trial: true`가 붙는다. 시험 실행은 되돌리기의 대상이 아니다 (`runs/last`에 나오지 않는다).
- 지시문을 바꿔 비교하려면 도구를 복제해 지시문을 고친 뒤 그 도구로 시험 실행한다.

이벤트는 직접 실행과 같고 `tool_call`·`tool_result`에 `trial: true`가 붙는다. `tool_result.result`에 결과 전문이 온다. 도구 실행 기록(`tool-runs`)의 항목에는 `trial`(bool)과 `base_seq`(다시 쓴 입력의 원래 실행 번호, 없으면 null)이 더해진다. 비교 화면은 `tool-runs`에서 `input`이 같은 것들을 나란히 놓으면 된다.

### 9.5 찾기와 비용

`GET /sessions/{id}/search?q=<찾을 말>&scope=<all|manuscript|materials>` — 사용자가 직접 쓰는 찾기.

```json
{ "hits": [ { "path": "원고/s3", "title": "1장 2번째 장면", "zone": "manuscript", "line": 4, "start": 12, "text": "…서윤은 숟가락을 들었다." } ],
  "truncated": false }
```

`zone`은 `manuscript` | `material`. `title`은 장면이면 자리, 자료면 `자료/`를 뗀 이름(`인물/서윤`). `line`은 줄 번호(1부터), `start`는 그 줄에서의 글자 위치, `text`는 그 줄. 200곳까지.

`GET /sessions/{id}/usage` — 이 작업에서 쓴 토큰과 비용.

```json
{ "runs": 12,
  "agent": { "prompt_tokens": 81200, "output_tokens": 9400, "cost_usd": 0.41 },
  "tools": [ { "tool": "compose", "label": "집필", "calls": 5, "total_tokens": 22100, "cost_usd": 0.12 } ],
  "auxiliary": { "calls": 9, "total_tokens": 5300, "cost_usd": 0.01 },
  "total_cost_usd": 0.54, "cost_complete": true }
```

`cost_complete`가 false면 단가를 모르는 모델의 호출이 빠져 있어 실제보다 적다. 비용을 전혀 모르면 `cost_usd`와 `total_cost_usd`가 null. 원고 통계(장별·장면별 분량)는 `workspace.manuscript`의 `chars`로 화면이 계산한다.

### 9.6 찾아 바꾸기 (에이전트의 도구)

에이전트의 기본 도구 `replace_all`(찾아 바꾸기)은 여러 문서를 한 번에 바꾼다. 자동 모드에서는 원고가 들어 있으면 확인이 온다 (수동 모드에서는 늘 오고, 자율 모드에서는 오지 않는다).

```json
{ "type": "user_input_required", "kind": "proposal", "action": "replace",
  "query": "서윤", "replacement": "서연", "path": "원고",
  "items": [ { "path": "원고/s1", "title": "1장 1번째 장면", "count": 3, "samples": [ { "before": "서윤은 난간을 붙잡고", "after": "서연은 난간을 붙잡고" } ] } ],
  "description": "찾아 바꾸기: '서윤' → '서연' (문서 2개, 5곳)" }
```

`path`는 에이전트가 준 범위다. 원고와 자료 전체면 빈 글(`""`), 아니면 `원고`, `원고/c2`, `자료/인물` 같은 경로. `items[].title`은 찾기와 같은 이름이다. 수정 방지가 걸린 문서는 건너뛰고 결과에 알린다.

### 9.7 웹 검색, 웹 페이지 읽기, 파일 보기

프리셋의 두 값으로 켜고 끈다 (기본 false). 화면에서는 에이전트 패널에 있다.

```ts
interface Preset { …; web_search: boolean; web_fetch: boolean; }
```

- 제공자가 실행하는 도구다. 웹 검색은 Claude·Gemini·OpenAI·OpenRouter, 페이지 읽기는 Claude·Gemini에서 된다. 지금 모델에서 되는지는 작업의 상태에 온다: `state.available = { web_search: true, web_fetch: false }`. 안 되는 모델에서는 켜 두어도 조용히 빠진다.
- 계획 모드에서도 쓸 수 있다 (읽기이므로).
- Gemini 2.5 이하는 이런 도구와 우리 도구를 같이 쓰지 못해서 `state.available`이 전부 false로 나온다.
- 제공자가 실행한 호출은 `done.total_tool_calls`에 세지 않는다.
- 흐름에는 도구 호출로 보인다: `tool_call`에 `tool: "web_search"`, `label: "웹 검색"`, `native: true`, `args`. 제공자마다 인자 이름이 달라도 검색어는 `args.query`, 주소는 `args.url`로 맞춰 준다 (원래 값도 같이 남는다). 호출과 결과는 `tool_call_id`로 맞춘다. `tool_result`에 `native: true`와 요약(`result`). 페이지 읽기는 `tool: "web_fetch"`, `label: "웹 페이지 읽기"`.
- 검색마다 제공자가 비용을 따로 받을 수 있다.

파일 보기: 에이전트의 기본 도구 `view_file`(파일 보기)은 자료의 이미지와 PDF를 모델에 그대로 보여 준다 (이미지를 볼 수 있는 모델에서만 된다). 그래서 글을 뽑지 못한 PDF도 올릴 수 있다. 파일 그대로 자료에 들어가고 `kind`가 `file`이다 (`file`은 PDF뿐이다). `GET /files`로 받을 수 있다.

```json
{ "path": "자료/올린 글/스캔.pdf", "kind": "file", "chars": 0,
  "note": "글을 뽑지 못해 파일 그대로 넣었습니다. 이미지를 볼 수 있는 모델이면 에이전트가 읽을 수 있습니다." }
```

### 9.8 폰트와 화면 설정

사용자가 폰트 파일을 올려 앱에 더한다. 올린 폰트는 앱 전체의 것이고(`data/fonts/`), 작업 파일(`.aleph`)에는 들어가지 않는다.

```ts
interface FontFace {
  id: string;                 // 파일 하나가 하나
  family: string;             // 폰트 이름. 파일 안에 적힌 것이고, 한글 이름이 있으면 그것이다 ("마루 부리")
  style: string;              // 파일 안에 적힌 모양 이름 ("Regular", "Bold" …)
  weight: [number, number];   // 굵기의 범위. 보통 폰트는 [700, 700], 가변 폰트는 [100, 900]
  italic: boolean;
  format: "truetype" | "opentype" | "woff" | "woff2";   // @font-face의 format() 값
  size: number;               // 바이트
  file: string;               // 올릴 때의 파일 이름
  url: string;                // "/api/fonts/<id>/file"
}
```

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /fonts` | | `{fonts: FontFace[]}`. 이름, 굵기 순 |
| `POST /fonts/upload?name=<파일 이름>` | 파일 바이트 그대로 | `FontFace`. 같은 파일을 다시 올리면 있던 것이 온다 |
| `GET /fonts/{id}/file` | | 폰트 파일 |
| `DELETE /fonts/{id}` | | `{status: "ok"}` |

- 받는 것: ttf, otf, woff, woff2. 40MB까지. 폰트가 아니거나 읽을 수 없으면 400, 여러 폰트를 묶은 파일(ttc)도 400 (`error`에 이유).
- 같은 `family`의 파일들이 한 폰트다. 화면은 `family`로 묶어 한 줄로 보여 주고, 파일마다 `@font-face`를 하나씩 만든다 (`font-weight`는 `weight`의 범위, `font-style`은 `italic`). 굵은 파일을 같이 올려 두면 굵은 글자에 그 파일이 쓰인다. 없으면 브라우저가 굵게 흉내 낸다.
- 폰트를 지워도 그것을 쓰던 설정은 그대로 둔다. 화면은 없는 폰트를 기본 폰트로 보여 준다.

화면 설정(자리마다의 폰트, 글자 크기, 글의 종류별 모양 등)은 엔진이 내용을 보지 않고 그대로 맡아 둔다. 모양은 화면이 정한다.

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /appearance` | | 저장해 둔 객체. 없으면 `{}` |
| `PUT /appearance` | 객체 (JSON, 200KB까지) | 저장된 객체 |

화면이 정한 모양 (엔진은 검사하지 않는다. 참고로 적어 둔다):

```ts
interface Appearance {
  version: 1;
  // 자리마다의 폰트 (font-family 이름). null이면 기본: system은 Noto Sans KR, body는 Noto Serif KR, title은 따로 없음
  fonts: { system: string | null; title: string | null; body: string | null };
  // 본문: 글자 크기 px (기본 16.5, 10~40), 줄 간격 배수 (기본 2, 1~4), 본문 너비 px (기본 720, 360~2000)
  body: { size: number; line_height: number; width: number };
  // 글의 종류별 모양. font·color가 null이면 "본문과 같음". color는 "#rrggbb"
  kinds: {
    normal: { font: string | null; color: string | null };
    bold:   { font: string | null; color: string | null; heavy: boolean };   // heavy: **…**를 두껍게 (기본 꺼짐)
    italic: { font: string | null; color: string | null; slant: boolean };   // slant: *…*, _…_를 눕힘 (기본 꺼짐)
    dquote: { font: string | null; color: string | null };   // "…" “…”
    squote: { font: string | null; color: string | null };   // '…' ‘…’
  };
}
```

- 폰트 이름은 묶음에 든 폰트면 `Noto Sans KR`, `Noto Serif KR`, `Gowun Batang`, `Pretendard`, 올린 폰트면 엔진이 준 `family`다.
- `{}`도 기본값으로 읽는다. 저장할 때는 받아 온 객체 위에 아는 키만 덮어써서 모르는 키는 남는다.
- 없는 폰트를 가리키면 그 자리는 기본 폰트로 보이고 값은 그대로 둔다.
- 제목 자리는 본문에 적은 제목 줄(`#`, `##`, `###`으로 시작하는 줄)과 원고 화면의 장 번호에 걸린다.
- 글의 종류별 모양은 본문 자리(원고, 출력)에만 걸린다. 표시만 바뀌고 글자는 그대로이며 내보낸 파일에는 들어가지 않는다.

### 9.9 모델 설정, 요약, 대화 압축

**프리셋의 모델 자리**: 두 묶음이다. 에이전트(`model`, `temperature`, `thinking`, `max_output_tokens`, `context_budget`)와 보조(`auxiliary_…` 다섯 칸). 5절의 `Preset`에 있다. 도구는 칸을 비우면 보조의 값을 따른다.

**요약 도구**: 보통 도구다. 입력을 읽고 출력에 쓴다. 이름이 `summarize`인 도구이고, 프리셋에 없으면 화면의 `+ 도구`에서 기본 꼴(`meta.summary_tool`)로 넣을 수 있다. 사용자가 고치거나 지울 수 있다. 엔진이 따로 취급하는 것은 없다. 요약을 붙이는 에이전트의 도구는 둘이다 (`meta.agent_tools`에 나온다).

| 도구 | 보이는 이름 | 하는 일 |
| --- | --- | --- |
| `set_summary` | 요약 붙이기 | 장면이나 장에 요약을 적는다. `args`: `target`, `summary`, `from_output`, `overwrite` |
| `summarize_scenes` | 묶음 요약 | 도구 하나를 장면 여러 개에 나란히 돌려서 나온 글을 각 장면의 요약으로 붙인다. `args`: `targets`(비우면 요약이 없거나 낡은 장면 전부), `tool`(비우면 요약 도구) |

- 둘 다 `tool_result`의 `changed`에 `원고`와 바뀐 장면이 온다. 화면은 원고 목록을 다시 읽으면 된다.
- 묶음 요약은 입력과 출력 자리를 건드리지 않는다. 장면마다의 실행은 도구 실행 기록에 `target`과 함께 남는다 (5절).
- 요약 도구가 없는 프리셋에서는 에이전트가 장면을 읽고 `set_summary`로 직접 붙인다.

**도구 호출 수**: 한도가 없다. 몇 번째 호출인지는 `tool_call_index`로 안다.

**대화 압축**: 엔진의 일이다 (프리셋의 도구가 아니고, 지시문도 엔진에 있다). 대화가 `context_budget`을 넘으면 두 단계로 줄인다.

1. 오래된 도구 결과를 비운다 (읽어 온 글은 다시 읽으면 되므로). 모델을 부르지 않는다. 이것으로 한도의 70% 아래로 내려가면 여기서 끝난다.
2. 그래도 넘으면 앞부분을 보조 모델로 요약한다. 최근 구간은 그대로 두고, 요약되는 구간에서 사용자가 한 말은 요약하지 않고 원문으로 남긴다 (한 번에 6,000자까지, 모두 합쳐 최근 것부터 30,000자까지).

이벤트:

```json
{ "type": "compaction", "kind": "cleared", "cleared_results": 3, "dropped_messages": 0, "kept_messages": 41,
  "tokens_before": 152000, "tokens_after": 96000, "summary": "" }
{ "type": "compaction", "kind": "summary", "cleared_results": 0, "dropped_messages": 28, "kept_messages": 13,
  "tokens_before": 151000, "tokens_after": 58000, "summary": "…요약한 글…" }
```

- `kind: "cleared"`는 "오래된 도구 결과 3개를 비웠다" 정도로 작게 보이면 된다. `summary`는 요약을 펼쳐 볼 수 있게 한다.
- 요약에 실패하면 그 앞에 `notice`(warning)가 오고, `summary`에는 부른 도구의 목록이 든다.

**켜고 끄기, 지금 압축** (채팅창의 컨텍스트 원그래프를 누르면 나오는 창):

- `자동 압축` 켜고 끄기: `PUT /sessions/{id}/state` `{auto_compact: false}`. 작업마다 기억한다. 꺼 두면 한도를 넘어도 줄이지 않는다 (원그래프는 100%를 넘을 수 있다). 모델이 받을 수 있는 길이를 넘으면 실행이 오류로 끝난다.
- `지금 압축`: `POST /sessions/{id}/conversation/compact`. 실행 중이면 409. 한도를 넘지 않았어도 2단계(요약)까지 한다.
  - 응답: 줄였으면 `{compacted: true, kind: "summary", dropped_messages, kept_messages, tokens_before, tokens_after, summary}`. 줄일 대화가 없으면(대화가 짧다) `{compacted: false}`.
  - 요약에 실패하면 502이고 대화는 그대로다. 프리셋에 모델이 없으면 400.
  - 요약을 기다리는 동안에는 그 작업에서 실행을 시작할 수 없다 (`POST …/runs`가 409). 화면은 `압축 중`일 때 보내기를 막으면 된다.
  - 대화 기록(`events`)의 맨 끝에 `{type: "compaction", manual: true, …}`가 붙는다 (`seq`와 `run_id`는 없다). `workspace.context.tokens`가 `tokens_after`로 바뀐다.
- `workspace.context.budget`은 이 작업이 쓰는 프리셋의 `context_budget`이다.

### 9.10 읽기 에이전트

에이전트의 기본 도구 `explore`(보이는 이름 `읽기 에이전트`). 여러 장면이나 긴 자료를 훑어야 하는 일을, 읽기 도구(목록 보기, 읽기, 찾기)만 쥔 다른 에이전트에게 맡기고 답만 돌려받는다. 읽은 글이 본 에이전트의 대화에 쌓이지 않는다. 보조 모델로 돈다 (온도, 추론, 최대 출력도 보조의 값). 모든 모드에서 쓸 수 있고 확인을 받지 않는다 (읽기만 한다).

이벤트는 다른 도구와 같다.

| 이벤트 | 값 |
| --- | --- |
| `tool_call` | `tool: "explore"`, `label: "읽기 에이전트"`, `args: {task}` (`task`가 맡긴 일이다) |
| `tool_stream` | 읽기 에이전트가 무엇을 보는지 한 줄씩 (`읽기: 원고/s3\n`, `찾기: 서윤\n`, `목록 보기: 전체\n`), 그 뒤에 답이 써지는 대로 |
| `tool_result` | `result`에 답. `changed`는 비어 있다. `trail`에 읽기 에이전트가 본 것이 차례로 온다 (`["읽기: 원고/s3", "찾기: 서윤"]`). 기록에 남으므로 나중에 다시 열어도 보인다 |

- 화면은 `tool_stream`을 집필 도구처럼 그 도구 호출 밑에 흘려 보이면 된다. 끝나면 `result`가 답이다. `tool_stream`은 기록에 남지 않으므로, 끝난 뒤에 무엇을 봤는지는 `tool_result.trail`로 보인다.
- 사용량은 `/usage`의 `auxiliary`에 잡힌다 (대화 압축과 같이). 도구 실행 기록(`/tool-runs`)에는 나오지 않는다.
- 읽기 에이전트의 지시문은 엔진에 있다 (프리셋의 도구가 아니다).
- 시연 서버: 원고에 장면이 있을 때 "훑어", "어긋나", "일관", "어떻게 그려", "어디에 나오"가 든 요청을 보내면 읽기 에이전트를 내보낸다.

### 9.11 한 작업에 여러 대화

작업 하나에 대화를 여럿 둘 수 있다. 문서와 원고, 입력과 출력, 프리셋은 작업의 것이고 대화들이 같이 쓴다. 대화마다 따로 있는 것은 화면 기록(`events`)과 에이전트의 기억, 컨텍스트의 크기다. 새 대화의 에이전트는 다른 대화에서 한 말을 모른다. 작업 공간에 적힌 것(자료, 노트)만 본다.

- 한 작업에서는 한 번에 하나만 돈다. 다른 대화에서 실행 중일 때 보내면 409다 (입력과 출력 자리가 작업에 하나뿐이라서). 실행 중에 다른 대화를 보거나 새 대화를 만드는 것은 된다.
- 첫 대화의 id는 `main`이다. 그 뒤의 대화는 서버가 id를 정한다 (소문자와 숫자 8자).
- 이름이 없는 대화는 첫 요청의 첫 줄(40자까지)이 이름이 된다.

| 메서드·경로 | 본문 | 응답 |
| --- | --- | --- |
| `GET /sessions/{id}/conversations` | | `{conversations: [Conversation], current}`. 만든 순서. `current`는 지금 보고 있는 대화 |
| `POST /sessions/{id}/conversations` | `{name?}` | 새 `Conversation`. 그것이 보고 있는 대화가 된다 |
| `PATCH /sessions/{id}/conversations/{cid}` | `{name}` | 고친 `Conversation` (`running`은 없다). 이름은 80자까지 |
| `DELETE /sessions/{id}/conversations/{cid}` | | 남은 목록 (`GET`과 같은 모양). 그 대화가 실행 중이거나 압축 중이면 409 |

```ts
interface Conversation {
  id: string;
  name: string;            // 비어 있으면 아직 한 번도 보내지 않은 대화다. 화면은 `새 대화`처럼 보이면 된다
  created_at: string;
  updated_at: string;      // 마지막으로 기록이 붙은 때
  context_tokens: number;  // 이 대화의 컨텍스트 크기
  running: boolean;        // 지금 이 대화에서 실행 중인가
}
```

- 대화를 지우면 그 기록과 에이전트의 기억이 없어진다. 문서와 원고는 그대로다. 마지막 대화를 지우면 빈 대화 하나(`main`)가 남는다.
- 보고 있는 대화: `state.conversation`. `PUT …/state` `{conversation}`으로 바꾼다 (화면에서 대화를 고를 때). 요청을 보내면 그 대화가 보고 있는 대화가 된다. 화면이 대화 id를 늘 적어 보내면 이 값에 기댈 일이 없지만, 새로 고쳤을 때 어느 대화를 열지 알 수 있다.

대화를 가리키는 값이 붙은 곳 (전부 안 주면 지금 보고 있는 대화):

| 곳 | 값 |
| --- | --- |
| `GET …/events` | `?conversation=`. 응답에 `conversation_id` |
| `POST …/runs`, `POST …/tools/{name}/run` | 본문의 `conversation`. 응답에 `conversation_id` |
| `GET …/workspace` | `?conversation=`. `context`가 `{conversation_id, tokens, budget}` (컨텍스트 크기는 대화마다 다르다) |
| `POST …/conversation/compact` | `?conversation=` |

작업 단위로 남는 것 (대화를 가리지 않는다):

- 실행: `GET …/stream`, `POST …/stop`, `…/steer`, `…/respond`는 그 작업에서 도는 하나의 실행을 다룬다. 이벤트마다 `conversation_id`가 붙어 오고, `events`의 `run.conversation_id`로 어느 대화가 도는지 안다. 화면은 보고 있는 대화가 아닌 대화의 이벤트는 그 대화에 쌓아 두면 된다.
- 되돌리기: `GET …/runs/last`는 작업에서 마지막으로 돈 실행이다. 응답에 `conversation_id`가 있다. 되돌리면 그 대화의 기억이 그 실행 전으로 돌아가고, `reverted` 이벤트는 그 대화에 붙는다.
- 모드, 권한 무시, 자동 압축, 프리셋: 작업의 상태다. 대화마다 따로 두지 않는다.
- 비용(`…/usage`), 제작 기록(`…/process-log`), 도구 실행 기록(`…/tool-runs`): 모든 대화를 합친 것이다.
- 내보내기(`.aleph`): 대화가 전부 들어간다.

### 9.12 이미지 모델

그림을 만드는 모델을 에이전트 모델과 따로 둔다. 그림을 만드는 모델(Gemini의 이미지 모델 등)은 보통 도구를 쓰지 못해서 에이전트 모델로 둘 수 없다.

- 프리셋의 `image_model: string`에 적는다 (`'제공자:모델'`. 비면 없음). 모델만 고른다. 온도 등은 없다.
- 정해 두면 에이전트가 기본 도구 `generate_image`(보이는 이름 `이미지 만들기`)를 받는다. 비어 있으면 그 도구가 없다. 계획 모드에서는 없다.
- 에이전트가 무엇을 그릴지 글로 써서 넘기면, 엔진이 이미지 모델을 불러 받은 그림을 `자료/삽화/<이름>.png`에 저장한다 (확장자는 받은 그림의 형식을 따른다. 같은 이름이 있으면 번호가 붙는다).

| 이벤트 | 값 |
| --- | --- |
| `tool_call` | `tool: "generate_image"`, `label: "이미지 만들기"`, `args: {prompt, name?, references?}` (`prompt`가 이미지 모델에 넘긴 글, `references`는 같이 보인 그림들의 경로) |
| `tool_result` | `result`에 저장된 경로와 원고에 넣는 법. `changed: ["자료/삽화/…png"]` (화면은 자료 목록을 다시 읽는다) |
| `user_input_required` | 수동 모드에서 만들기 전에 온다. `kind: "tool_confirm"`, `tool: "generate_image"`, `label: "이미지 만들기"`, `input`에 넘길 글 |

- 이미지 모델이 그림 대신 글만 돌려주면(거절 등) `result`에 그 말이 온다. 그림을 못 만드는 모델을 골랐으면 그렇다고 알린다. 둘 다 `ok: true`가 아닐 수 있으니 `result`의 글을 그대로 보이면 된다.
- 사용량은 `/usage`의 `auxiliary`에 잡힌다. 도구 실행 기록(`tool_calls.jsonl`)에는 `[image]`로 남는다 (모델, 넘긴 글, 저장된 경로).
- 프리셋의 이미지 모델에 쓸 제공자가 준비되지 않았으면 실행을 시작할 때 400이다 (에이전트 모델, 보조 모델과 같다).
- 시연 서버: 가짜 이미지 모델 `demo:image`가 들어 있다 (두 색으로 나뉜 그림 한 장을 낸다). 저절로 잡히지는 않는다. 에이전트 패널의 `이미지 모델`에서 `시연용 가짜 모델`의 `image`를 고른 뒤, "삽화를 그려 줘"처럼 그림·삽화·이미지와 그려·만들이 같이 든 요청을 보내면 만든다.

### 9.13 프리셋의 시작 모드

프리셋이 일하는 방식을 정한다 (에이전트가 혼자 끝까지 쓴다, 같이 쓴다, 사용자가 쓰고 에이전트는 거든다). 모드가 그것과 어긋난 채로 작업이 열리지 않게, 프리셋이 시작 모드를 정할 수 있다.

- 프리셋의 `start_mode`: `""`(정하지 않음. 앱의 기본값 `auto`로 열린다) 또는 `manual` | `auto` | `autonomous` | `plan`. `PUT`·`PATCH /presets/{id}`로 고친다. 없는 모드를 보내면 `PATCH`는 400, `PUT`은 422. 내보낸 프리셋 파일(`preset.yaml`)에도 들어간다.
- `POST /sessions`로 작업을 만들 때 그 프리셋의 `start_mode`가 작업의 `mode`가 된다. **만들 때 한 번뿐이다.** 그 뒤에 사용자가 채팅창에서 바꾼 모드가 남고, 작업의 프리셋을 다른 것으로 바꿔도 모드는 그대로다. 이미 있던 작업에는 영향이 없다.
- 화면의 선택지는 `/meta`의 `modes`와 `정하지 않음`이다. 새 작업의 모드는 `GET /sessions/{id}/state`의 `mode`에 온다.

