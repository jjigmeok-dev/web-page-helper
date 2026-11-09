# web-page-helper

빌드 없는 HTML/CSS/JS 프론트엔드 툴킷. **헤드리스 파운데이션**(동작·ARIA만 담당)을 **유저 컴포넌트**(마크업+CSS)로 조립하고, 브라우저에서 직접 편집한다. 번들러도, 프레임워크도, 컴파일 단계도 없다.

```bash
npm run studio          # http://127.0.0.1:4174/__studio — 비주얼 에디터
npm run dev             # http://127.0.0.1:4173        — 정적 데모 서버
npm test                # 131개 (브라우저 e2e 포함, Chromium 없으면 skip)
```

CLI는 `npm run hf -- <명령>` 또는 `node tools/cli.mjs <명령>`으로 실행한다.

| 명령 | 용도 |
| --- | --- |
| `hf list` | 파운데이션·유저 컴포넌트·페이지 목록 (`index.html`, `pages/*.html`) |
| `hf new foundation <name>` | 헤드리스 파운데이션 스캐폴드 + `foundation/index.js` 등록 |
| `hf new component <name>` | 유저 컴포넌트 `components/<name>/{<name>.js,<name>.css}` 스캐폴드 |
| `hf new page <name>` | `pages/<name>.html` 스캐폴드 |
| `hf serve [--port 4173] [--root <dir>]` | 정적 dev 서버 (빌드·watcher 없음) |
| `hf studio [--port 4174] [--root <dir>] [--proxy <url>]` | 비주얼 에디터 |
| `hf projects add <dir>` | 프론트엔드를 등록하고 프로필 수집 |
| `hf projects list` | 등록된 프로젝트 목록 |
| `hf projects show <name>` | 프로필 전체 출력 (페이지·스타일시트·경고) |
| `hf projects up <name>` | 프로필 출력 후 해당 프로젝트로 에디터 실행 |
| `hf projects remove <name>` | 등록 해제 |
| `hf validate` | 파운데이션 계약(클래스/인라인 스타일/CSS 금지) 검사 |

`--root`를 생략하면 **현재 디렉터리**를 대상으로 삼는다. 다른 프로젝트에서 `hf studio`를 실행하면
그 프로젝트의 `index.html`/`pages/`를 연다. 툴킷 자체를 편집하려면 툴킷 루트에서 실행한다.

스캐폴드로 시작하는 흐름:

```bash
npm run hf -- new foundation my-widget   # 동작 + ARIA + meta
npm run hf -- new component promo-card   # 파운데이션을 조립한 유저 컴포넌트
npm run hf -- new page about             # 페이지
npm run dev                              # http://127.0.0.1:4173/pages/about.html
npm run studio                           # 브라우저에서 선택 → 편집 → 저장
npm run hf -- validate                   # 계약 위반 0 확인
```

## 다른 프로젝트에 붙이기

기존 프론트엔드를 편집하려면 등록해 두고 이름으로 연다. 등록 정보는 `~/.hf/projects.json`에만
쓰이고 대상 디렉터리에는 아무 파일도 남기지 않는다.

```bash
hf projects add ~/work/my-site      # 프로필 수집 + 등록
hf projects up my-site              # http://127.0.0.1:4174/__studio
```

`add`/`show`/`up`은 먼저 **프로필**을 출력한다 — 무엇이 편집 가능하고 무엇이 막혔는지:

```
my-site  ·  static · no build step
  1/1 editable pages · 1 stylesheets · 3 scripts · 0 assets
  0 components · 0 foundations · 9 design tokens
  · pages call /api; start the app backend and pass --proxy <url> so the preview gets real data
```

스튜디오의 **Project** 탭에도 같은 정보가 나온다. 페이지가 `/api/…`를 호출한다면 백엔드를 띄우고
`--proxy`로 연결한다. 그래야 미리보기가 `404 /api/...` 대신 실제 데이터를 그린다.

```bash
hf studio --root ~/work/my-site --proxy http://127.0.0.1:8000
```

프록시는 **파일이 아닌 경로만** 넘긴다. `__studio`, `__api`, 실제 파일은 항상 스튜디오가 처리하고,
`MISSING`일 때만 백엔드로 전달한다.

| 경로 | 쓰는 시점 | 내용 |
| --- | --- | --- |
| `~/.hf/projects.json` | `projects add` | 등록 정보 + 마지막 프로필 요약. 대상 디렉터리는 건드리지 않는다 |
| `<project>/.hf/` | 스튜디오에서 **저장**할 때 | undo 저널과 백업(최근 20개). 프로젝트에 `.hf/`를 gitignore로 추가할 것 |

프로필 수집(`add`/`show`/`up`)은 읽기 전용이므로 프로젝트에 아무 파일도 생기지 않는다.

## 구조

| 경로 | 역할 |
| --- | --- |
| `foundation/` | 헤드리스 파운데이션 12종. 클래스/인라인 스타일/CSS를 절대 넣지 않는다 |
| `compose/` | `defineComponent` — 파운데이션을 조립해 유저 컴포넌트를 정의 |
| `components/` | 유저 컴포넌트 (`*.js` + `*.css`) |
| `studio/` | 에디터 UI (정적 ESM, 빌드 없음) |
| `tools/scan/` | HTML·CSS 스캐너 (모든 노드/선언의 바이트 범위) |
| `tools/studio/` | 프로젝트 모델, 편집 엔진, 저널, API, 서버 |
| `docs/EDITOR-PLAN.md` | 에디터 요구사항과 설계 |

### 파운데이션 계약

파운데이션은 동작과 ARIA만 소유한다. `class`, `style`, `<style>`을 쓰지 않고, 상태는 `data-state`, `data-hf-*`, `aria-*`로만 노출한다. `hf validate`가 이를 강제한다.

```js
import { mount, meta } from './foundation/disclosure.js';

export default {
  ...meta,
  mount,
};
```

```html
<div data-hf="disclosure" data-hf-options='{"defaultOpen":true}'>
  <button data-hf-part="trigger">Details</button>
  <div data-hf-part="panel">Body</div>
</div>
```

## 스튜디오

`npm run studio` → 브라우저에서 `/__studio`. 서버는 `127.0.0.1`에만 바인딩된다.

- **구조 트리 / 미리보기 클릭**: 같은 노드를 가리킨다.
- **Pick in preview**: 기본 **켜짐**. 프리뷰에서 요소를 그냥 클릭하면 선택되고, 페이지 자체를 조작하려면 끈다.
- **실시간 프리뷰**: 편집은 저장 전에 프리뷰에 즉시 반영된다. 선언은 CSSOM에 직접 적용되므로 삭제가 실제로 삭제되고(원본 규칙이 다시 이김), `Discard`/`Esc`로 원상복구한다. 파일은 `Save` 확인 전까지 바뀌지 않는다.
- **Owned by**: 선택한 요소를 **어느 파일에서 고쳐야 하는지** 세 갈래로 나눠 보여준다. 헤드리스 UI는 한 요소가 여러 파일에 걸쳐 있기 때문에 하나로 뭉뚱그리면 틀린 파일을 연다.
  - `markup` — 이 요소가 실제로 적힌 파일과 줄 (`index.html:20`)
  - `behavior` — 이벤트/ARIA를 배선한 모듈. `data-hf` 인스턴스면 `foundation/*.js`, `hf-*` 커스텀 엘리먼트면 `components/*/*.js`. 파트 안쪽이면 어느 파트인지도 표시한다.
  - `styles` — 실제로 이 요소에 매칭된 모든 스타일시트 (컴포넌트 시트는 `(component)`로 구분)
  - 컴포넌트가 **렌더링한 내부 요소**를 클릭하면 호스트만이 아니라 실제 클릭 대상을 함께 보고하고, 그 요소가 컴포넌트 템플릿 어느 부분인지(`<h3 class="example-card__title">{{ title }}</h3>`)와 템플릿 파일을 보여준다. 페이지 파일에는 호스트만 있으므로 페이지를 고쳐도 내부는 바뀌지 않는다.
  - 이때 **Layout 편집은 컴포넌트 CSS로 간다.** 내부 요소의 클래스로 규칙을 만들므로(`.example-card__title { … }` → `components/example-card/example-card.css`), 페이지 시트에 규칙을 써서 컴포넌트 시트에 덮이는 일이 없다.
- **Element**: 텍스트 콘텐츠와 **속성 편집**. 속성 이름/값을 고치거나, ✕로 지우거나, 없는 속성을 추가한다(`role`, `aria-*`, `tabindex`, `data-*` 등). 값은 저장 시 HTML 엔티티로 이스케이프되므로 따옴표가 태그를 깨뜨릴 수 없다. 매칭되는 CSS 규칙도 함께 보여준다.
- **Suggestions**(Element 패널 하단): 선택한 요소에 대해 **무엇을 바꿀 수 있는지** 제안한다. 심각도 순(Error → Warning → Suggestion)으로 정렬되고, 제안은 전부 기존 op로 표현되므로 `Apply`를 누르면 손으로 필드를 고친 것과 같은 pending diff에 들어간다. 파일을 직접 쓰지 않는다.
  - **계약(Error/Warning)**: `meta.required`에 선언된 part 누락, 알 수 없는 part, part 태그 불일치(`button|a` 유니온 지원). foundation이 마운트 중 던지는 조건과 같은 목록이다.
  - **접근성(Error)**: `img`의 `alt`, `a`의 `href`, 접근 가능한 이름이 없는 `button`/`input`/`select`/`textarea`, 제목 단계 건너뜀.
  - **구조(Error/Warning)**: 중복 `id`, 빈 컨테이너, foundation 밖의 고아 part.
  - **스타일(Warning)**: 클래스/id/커스텀 태그라는 훅을 붙였는데 그 훅을 쓰는 규칙이 없음. 규칙이 아예 없는 `<p>`처럼 상속이 정상인 경우는 경고하지 않는다.
  - **모양·크기·색상(Suggestion)**: 자식 배치(`display:flex` + `gap`), 줄바꿈 허용, 패딩, 모서리, 텍스트/배경색. 페이지가 정의한 토큰(`--hf-gap`, `--hf-radius`, `--hf-fg`, `--hf-surface`)이 있으면 `var(...)`로 참조하고, 이미 선언된 속성은 다시 제안하지 않는다.
  - **로직(Suggestion)**: 아직 쓰지 않은 foundation 옵션/컴포넌트 prop(적용 시 기존 옵션을 보존), 비어 있는 part, 동작 계층이 없는 상호작용 태그.
- **Layout**: `display`, `flex-direction`, `gap`, `padding`, `align-items`, `justify-content`, `grid-template-columns`를 **원본 CSS 규칙에 직접** 기록한다. 규칙이 없으면 새로 만든다.
- **Component**: `data-hf` 파운데이션은 `data-hf-options`를, `hf-*` 유저 컴포넌트는 props 속성을 폼으로 편집한다.
- **Structure**: 파운데이션/컴포넌트 스니펫 삽입, 이동, 래핑, 복제, 삭제. 복제본에서는 `id`와 그 `id`를 가리키던 `aria-*` 참조를 제거해 문서의 id 유일성을 지킨다. `foundation/`·`components/` 레지스트리가 없는 프로젝트에서는 삽입 컨트롤이 비활성화되고 이유를 표시한다.
- **Frames**: `<body>`를 헤더/사이드바/메인/푸터 골격으로 감싸고 기존 콘텐츠를 슬롯으로 옮긴다.
  - **DOM이 없어도 된다.** 빈 파일, 텍스트만 있는 파일, body 없는 프래그먼트, `<body />` 모두 프레임을 적용할 수 있다. 문서 뼈대(`doctype`/`html`/`head`/`body`)가 없으면 그 자리에서 만들고 기존 내용을 슬롯으로 옮긴다. Frames 패널의 Target 문구가 이번에 무엇이 생성될지 먼저 알려준다.
  - 스타일시트를 `<link>`하지 않은 페이지라면 `style.css`를 **만들고** `<head>`에 링크까지 넣는다. 만들기만 하고 링크를 빠뜨리면 프레임 CSS가 적용되지 않기 때문이다.
  - 파일 생성은 **명시적일 때만**(`createFile`) 일어난다. 지운 파일이 편집 중에 되살아나지 않는다.

### 안전 규칙

편집은 **범위 치환**이다. DOM을 다시 직렬화하지 않으므로 변경 범위 밖 바이트는 그대로 남는다.

1. 모든 op은 파일 버전(SHA-256)을 확인한다. 디스크가 바뀌었으면 `409 STALE_VERSION`, 아무것도 쓰지 않는다.
2. 배치를 적용한 뒤 파일을 **재스캔**한다. 구문 문제가 늘면 쓰지 않는다.
3. 쓰기는 임시 파일 + `rename` (원자적). 중간에 실패하면 이미 쓴 파일을 되돌린다.
4. 저장 전에 diff를 보여주고, 확인해야 디스크에 쓴다.
5. 모든 쓰기는 `.hf/backups/`에 스냅샷을 남긴다. `Undo`(또는 `Ctrl/Cmd+Z`)가 복원한다.

편집 불가 대상: 프로젝트 루트 밖 경로, `node_modules`/`.git`/`.hf`, 2MB 초과 파일, UTF-8이 아닌 파일, 스캔 문제가 있는 파일.

### 단축키

| 키 | 동작 |
| --- | --- |
| `Ctrl/Cmd+S` | diff 검토 후 저장 |
| `Ctrl/Cmd+Z` | 대기 중인 변경 취소 → 없으면 마지막 저장 Undo |
| `Esc` | 대기 중인 변경 취소 |
| `↑`/`↓` (트리 포커스) | 선택 이동 |

## API

서버는 HTTP 타입을 모르는 핸들러(`tools/studio/api.mjs`)에 위임한다. 테스트는 HTTP 없이 핸들러를 직접 호출한다.

| 엔드포인트 | 용도 |
| --- | --- |
| `GET /__api/project` | 페이지·스타일·컴포넌트·파운데이션 목록 |
| `GET /__api/page?file=index.html` | 노드 트리, 시트 버전, 매칭 규칙, 토큰 |
| `GET /__api/source?file=…` | 파일 원문 + 버전 |
| `POST /__api/plan` | 드라이런: diff만 계산 |
| `POST /__api/apply` | 스냅샷 + 원자적 쓰기 |
| `POST /__api/undo` | 스냅샷 복원 |
| `GET /__api/history` | 최근 스냅샷 |

### op

```js
{ op: 'setDecl',    file: 'styles/demo.css', selector: '.grid', property: 'gap', value: '2rem', expect: '1.25rem' }
{ op: 'setAttr',    file: 'index.html', node: '0.0.1.0.0.0', name: 'data-hf-options', value: '{"defaultOpen":true}' }
{ op: 'removeAttr', file: 'index.html', node: '0.0.1.0.0.1', name: 'tabindex' }
{ op: 'insertNode', file: 'index.html', node: '0.0.1', position: 'append', html: '<div data-hf="toggle">…</div>' }
{ op: 'duplicateNode', file: 'index.html', node: '0.0.1.0' }
{ op: 'moveNode',   file: 'index.html', node: '0.0.1.0', target: '0.0.1.2', position: 'append' }
{ op: 'wrapNode',   file: 'index.html', node: '0.0.1.0', html: '<section class="wrap">' }
{ op: 'frameNode',  file: 'index.html', node: '0.0.1', html: '<div class="layout">…<main data-hf-frame-slot></main>…</div>' }
```

노드 id는 구조적 인덱스 경로(`0.0.1.0.2`)다. 배치 안의 모든 op은 **같은 스냅샷**에 대해 계산되므로, 앞선 op이 뒤 노드의 id를 밀지 않는다.

## 테스트

```bash
npm test     # 131개: 스캐너, 편집 엔진, 저널, API, 서버, 프로필/레지스트리, 소유권 판정, 빈 DOM 부트스트랩, 제안 엔진, op 빌더, 브라우저 e2e
```

`tests/studio.test.mjs`는 실제 프로젝트를 임시 디렉터리에 복사해 HTTP 왕복까지 검증한다.
`tests/studio.e2e.test.mjs`는 Chromium을 띄워 미리보기 선택 → 폼 편집 → diff 확인 → 디스크 검증과 stale 거부를 실제 UI로 확인한다. Chromium이 없으면 skip한다.
`tests/project.test.mjs`는 프로필 수집, 레지스트리(`HF_HOME`으로 격리), `GET /api/profile`, 입력 검증을 덮는다.
`tests/owner.test.mjs`는 마크업/동작/스타일이 서로 다른 파일에 있는 프로젝트에서 소유권 판정을 검증한다.
`tests/bootstrap.test.mjs`는 빈 파일·프래그먼트·`<body />`에 프레임을 적용하고, 스타일시트가 없을 때 생성되는지 검증한다.
`tests/suggest.test.mjs`는 제안 엔진이 지원하는 op만 내보내는지, 계약/접근성/구조 규칙이 오탐 없이 동작하는지, 제안을 적용하면 결함이 실제로 사라지는지 검증한다.
