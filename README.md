# web-page-helper

빌드 없는 HTML/CSS/JS 프론트엔드 툴킷. **헤드리스 파운데이션**(동작·ARIA만 담당)을 **유저 컴포넌트**(마크업+CSS)로 조립하고, 브라우저에서 직접 편집한다. 번들러도, 프레임워크도, 컴파일 단계도 없다.

## 퀵스타트

### 1. 설치

Node.js 22 이상. 내장 모듈(`node:http`, `node:test`, `node:fs`)만 쓰고, 검증은 22.23.2에서 했다.
빌드 도구·번들러는 설치하지 않는다.

```bash
git clone https://github.com/jjigmeok-dev/web-page-helper
cd web-page-helper
npm ci
```

### 2. 에디터 열기

```bash
npm run studio
```

→ <http://127.0.0.1:4174/__studio>. 끝이다. 오른쪽 패널에서 요소를 골라 고치고 `Save`를 누르면 디스크의 HTML/CSS가 바뀐다.
포트를 바꾸려면 `npm run studio -- --port 5000`, 다른 프로젝트를 열려면 상단 `Open…`.

### 3. 데모 서버로 페이지 보기

```bash
npm run dev
```

→ <http://127.0.0.1:4173>. 파일을 고치고 새로고침하면 반영된다. watcher도 빌드 단계도 없다.

### 4. 컴포넌트 만들기

파운데이션(동작·ARIA)을 유저 컴포넌트(마크업·CSS)로 조립한다.

```bash
npm run hf -- new foundation my-widget   # foundation/my-widget.js + index.js 등록
npm run hf -- new component promo-card   # components/promo-card/{js,css}
npm run hf -- new page about             # pages/about.html
```

만든 뒤 계약을 검사하고 목록을 확인한다.

```bash
npm run hf -- validate   # 클래스/인라인 스타일/CSS 주입 금지 검사
npm run hf -- list       # 파운데이션·컴포넌트·페이지 목록
```

### 5. 다른 프로젝트에 붙이기

이미 있는 프론트엔드를 등록하면 스택·페이지·토큰을 프로파일링하고 바로 에디터로 연다.

```bash
npm run hf -- projects add ~/work/my-site
npm run hf -- projects up my-site        # 프로필 출력 후 studio 실행
```

프로필 출력, `--proxy` 연결, `~/.hf` 저널 위치는 [다른 프로젝트에 붙이기](#다른-프로젝트에-붙이기)에 있다.

### 6. 테스트

```bash
npm test
```

148개(브라우저 e2e 포함). Chromium이 없으면 e2e만 `skip`으로 표시되고 나머지는 그대로 실행된다.
e2e까지 돌리려면 한 번만 설치한다:

```bash
npx playwright install chromium
npm test
```

## 명령

CLI는 `npm run hf -- <명령>` 또는 `node tools/cli.mjs <명령>`으로 실행한다.

| 명령 | 용도 |
| --- | --- |
| `hf list` | 파운데이션·유저 컴포넌트·페이지 목록. 페이지는 `pages/`만이 아니라 루트 아래 모든 `.html`을 찾는다(실제 프로젝트는 `app/dashboard.html`처럼 중첩된다) |
| `hf new foundation <name>` | 헤드리스 파운데이션 스캐폴드 + `foundation/index.js` 등록 |
| `hf new component <name>` | 유저 컴포넌트 `components/<name>/{<name>.js,<name>.css}` 스캐폴드 |
| `hf new page <name>` | `pages/<name>.html` 스캐폴드 |
| `hf serve [--port 4173] [--root <dir>] [--host <addr>]` | 정적 dev 서버 (빌드·watcher 없음) |
| `hf studio [--port 4174] [--root <dir>] [--host <addr>] [--token <v>] [--browse-root <dir>] [--proxy <url>]` | 비주얼 에디터 |
| `hf projects add <dir>` | 프론트엔드를 등록하고 프로필 수집 |
| `hf projects list` | 등록된 프로젝트 목록 |
| `hf projects show <name>` | 프로필 전체 출력 (페이지·스타일시트·경고) |
| `hf projects up <name>` | 프로필 출력 후 해당 프로젝트로 에디터 실행 |
| `hf projects remove <name>` | 등록 해제 |
| `hf validate` | 파운데이션 계약(클래스/인라인 스타일/CSS 금지) 검사. 파일 단위로 세므로 12개로 보고된다 |

`--root`를 생략하면 **현재 디렉터리**를 대상으로 삼는다. 다른 프로젝트에서 `hf studio`를 실행하면
그 프로젝트의 `index.html`/`pages/`를 연다. 툴킷 자체를 편집하려면 툴킷 루트에서 실행한다.

## 호스팅: 로컬 / IP

기본값은 `127.0.0.1`이고 이때는 토큰이 없다. 같은 네트워크의 폰이나 다른 PC에서 열려면 `--host`를 준다.

```bash
hf studio --host 0.0.0.0                    # → http://0.0.0.0:4174/__studio?token=…
hf studio --host 0.0.0.0 --token my-secret  # 토큰 고정
hf serve  --host 0.0.0.0                    # 데모 서버도 동일
```

루프백이 아닌 바인딩은 **항상 토큰이 필요하다**. `--token`을 생략하면 임의 토큰을 생성해 출력하고,
`?token=`(또는 `x-hf-token` 헤더)이 없는 요청은 API·정적 파일·`/__studio` 셸까지 전부 401이다.
출력되는 `lan` 줄이 실제 접속 주소다. 사용자 계정 개념이 없으므로 `0.0.0.0`은 신뢰된 네트워크에서만 쓴다.

### 폴더 선택

에디터 상단 `Open…`으로 로컬 디렉터리를 탐색해 다른 프로젝트를 연다. **현재 디렉터리가 아니라 계정의 홈(`~`)에서 시작**하고,
`Up`으로 상위 폴더를 오갈 수 있다. `.html`이 하나 이상 있는 폴더만 열 수 있으며, 고르면 서버의 root가 바뀌어
**재시작 없이** 페이지·구조·미리보기가 전부 갱신된다. 저장하지 않은 변경이 있으면 전환 전에 확인을 받는다.

탐색 범위는 **여러 루트**다: 기본은 `~` + 현재 프로젝트. 홈 밖(`/srv`, `/tmp`)에 체크아웃한 프로젝트도 열 수 있도록
프로젝트를 별도 루트로 더한다. 부모로 넓히지 않는 이유는 `/srv/app`의 부모가 `/srv` 전체가 되기 때문이다.
루트는 다이얼로그 상단 칩으로 표시되어 한 번에 이동한다. `--browse-root <dir>`을 주면 `~` 대신 그 경로를 쓰고,
프로젝트 루트는 그대로 유지된다. 어느 루트에도 속하지 않는 경로는 `OUT_OF_ROOT`로 거부한다.

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
| `foundation/` | 헤드리스 파운데이션 13종 / 12개 파일(`switch`는 `toggle.js`에서 함께 내보낸다). 클래스/인라인 스타일/CSS를 절대 넣지 않는다 |
| `compose/` | `defineComponent` — 파운데이션을 조립해 유저 컴포넌트를 정의 |
| `runtime/` | `[data-hf]` 자동 마운트, `use()`, `hf-*` 엘리먼트 관찰 |
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

#### `meta.parts` vs `meta.required`

`parts`는 **전체 슬롯 목록**이고, 그중 무엇이 없으면 `mount()`가 던지는지는 `required`에 따로 적는다. 둘을 구분하지 않으면 선택 슬롯(메뉴의 `separator`, 스위치의 `thumb`)까지 누락으로 오판한다.

```js
export const meta = {
  name: 'menu',
  parts:    { trigger: 'button', list: 'any', item: 'button', separator: 'any' },
  required: ['trigger', 'list'],   // 없으면 mount()가 throw
  options:  { placement: 'bottom-start', loop: true, typeahead: true },
  events:   ['hf:open', 'hf:close', 'hf:select'],
};
```

`parts` 값은 `any`(태그 무관) 또는 `a|b` 유니온이다. 루트 엘리먼트가 슬롯을 대신하는 파운데이션(`toggle`, `switch`, `listbox`)은 `required: []`다. 스튜디오의 **Suggestions**가 이 두 필드로 계약 위반을 판정하므로, 파운데이션을 추가할 때 `required`를 빠뜨리면 진단도 동작하지 않는다.

`hf new foundation` 스캐폴드는 `parts`/`required`를 함께 생성한다.

## 스튜디오

`npm run studio` → 브라우저에서 `/__studio`. 기본 바인딩은 `127.0.0.1`이고, 네트워크에 열려면 `--host 0.0.0.0`(토큰 필수)을 준다 — [호스팅](#호스팅-로컬--ip) 참고.

- **Open…**: 상단 버튼으로 로컬 폴더를 골라 다른 프로젝트를 연다. 홈에서 시작하고, `.html`이 있는 폴더만 열 수 있으며, 고르면 재시작 없이 페이지·트리·미리보기가 전부 새 프로젝트로 바뀐다. 저장하지 않은 변경이 있으면 먼저 확인을 받는다.
- **관련 설정만 표시**: 우측 패널의 탭은 **선택한 요소에 적용되는 것만** 남는다. 선택이 바뀌면 가장 구체적인 탭이 자동으로 열린다.
  - 컴포넌트(`data-hf`, `hf-*`)를 클릭 → **Component** (옵션/props 폼)
  - 일반 요소(`p`, `div`, `h1`…) → **Layout** (박스 모델)
  - 박스가 없는 요소(`script`, `title`, `link`, `meta`…) → **Layout** 탭 자체가 숨는다
  - 탭을 직접 고르면 그 선택이 유지되고, 다른 요소를 선택하면 다시 자동 선택으로 돌아간다
  - 패널 안에서도 빈 섹션(적용 규칙 0개, 디자인 토큰 없음)은 렌더하지 않는다
- **? 아이콘**: 모든 탭·섹션 제목·설정 필드 우측에 있고, 마우스를 올리면 그 설정이 무엇인지 **한국어**로 설명한다. 아이콘을 클릭해도 탭이 바뀌지 않는다.
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
  - **모양·크기·색상(Suggestion)**: 자식 배치(`display:flex` + `gap`), 줄바꿈 허용, 패딩, 모서리, 텍스트/배경색. 이미 선언된 속성은 다시 제안하지 않는다.
    토큰은 **페이지가 실제로 정의했을 때만** `var(...)`로 참조하고, 없으면 리터럴 폴백을 쓴다. `--hf-radius`·`--hf-fg`·`--hf-surface`는 `styles/base.css`에 있지만, `--hf-gap`·`--hf-space`는 기본 제공되지 않으므로 직접 정의해야 `var()`가 나온다.
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
| `GET /__api/profile` | 프론트엔드 프로필: 페이지 수·자산·토큰·편집 차단 사유 |
| `GET /__api/page?file=index.html` | 노드 트리, 시트 버전, 매칭 규칙, 토큰 |
| `GET /__api/source?file=…` | 파일 원문 + 버전 |
| `POST /__api/plan` | 드라이런: diff만 계산 |
| `POST /__api/apply` | 스냅샷 + 원자적 쓰기 |
| `POST /__api/undo` | 스냅샷 복원 |
| `GET /__api/history` | 최근 스냅샷 |
| `GET /__api/browse?dir=…` | 폴더 선택용 디렉터리 한 단계 (`--browse-root` 밖은 `OUT_OF_ROOT`) |
| `POST /__api/open` | 프로젝트 루트 전환 (`{"dir": "/abs/path"}`). `.html`이 없으면 `NO_PAGES` |

`browse`/`open`은 서버의 root를 바꾼다. 핸들러는 root를 인자로 받지 않고 **호출 시점에 읽으므로**
(`createApi(() => state.root)`), 전환 뒤 모든 요청이 새 프로젝트를 대상으로 한다. 재시작은 필요 없다.
`browseRoot`는 `--browse-root`(기본: 프로젝트의 부모)로 정해지고, 그 밖을 가리키는 경로는 거부한다.

### op

15종이다. 모든 op은 `file`을 받고, HTML op은 `node`(노드 id), CSS op은 `selector`를 쓴다.

| op | 대상 | 하는 일 |
| --- | --- | --- |
| `setDecl` | CSS | 규칙에 선언 추가/교체. `expect`로 이전 값을 검증 |
| `setDecls` | CSS | 여러 선언을 한 번에 (`decls` 객체) |
| `removeDecl` | CSS | 선언 삭제 |
| `appendCss` | CSS | 파일 끝에 CSS 텍스트 추가 |
| `setAttr` | HTML | 속성 설정 (값은 저장 시 이스케이프) |
| `removeAttr` | HTML | 속성 삭제 |
| `setText` | HTML | 리프 노드의 텍스트 교체. 자식이 있으면 `NOT_A_LEAF` |
| `appendToHead` | HTML | `<head>`에 마크업 삽입 (스타일시트 링크 등) |
| `insertNode` | HTML | `before`/`after`/`prepend`/`append`로 삽입 |
| `removeNode` | HTML | 노드 삭제 |
| `duplicateNode` | HTML | 복제. 복제본의 `id`와 그를 가리키던 `aria-*` 참조를 제거 |
| `moveNode` | HTML | 다른 위치로 이동 |
| `wrapNode` | HTML | 새 래퍼로 감싸기 |
| `frameNode` | HTML | 페이지 레이아웃 프레임 적용 (`data-hf-frame-slot`으로 기존 콘텐츠 이동) |
| `frameDocument` | HTML | DOM이 없는 페이지에 문서 뼈대를 만들며 프레임 적용 |

```js
{ op: 'setDecl',    file: 'styles/demo.css', selector: '.grid', property: 'gap', value: '2rem', expect: '1.25rem' }
{ op: 'setAttr',    file: 'index.html', node: '0.0.1.0.0.0', name: 'data-hf-options', value: '{"defaultOpen":true}' }
{ op: 'removeAttr', file: 'index.html', node: '0.0.1.0.0.1', name: 'tabindex' }
{ op: 'insertNode', file: 'index.html', node: '0.0.1', position: 'append', html: '<div data-hf="toggle">…</div>' }
{ op: 'duplicateNode', file: 'index.html', node: '0.0.1.0' }
{ op: 'moveNode',   file: 'index.html', node: '0.0.1.0', target: '0.0.1.2', position: 'append' }
{ op: 'wrapNode',   file: 'index.html', node: '0.0.1.0', html: '<section class="wrap">' }
{ op: 'frameNode',  file: 'index.html', node: '0.0.1', html: '<div class="layout">…<main data-hf-frame-slot></main>…</div>' }
{ op: 'frameDocument', file: 'index.html', html: '<div class="layout">…</div>', stylesheet: '/style.css' }
```

노드 id는 구조적 인덱스 경로(`0.0.1.0.2`)다. **HTML op**은 배치 안에서 같은 스냅샷에 대해 계산되므로, 앞선 op이 뒤 노드의 id를 밀지 않는다.

**CSS op**은 반대로 **순차 적용**된다. CSS는 selector로 규칙을 찾지 위치 id를 쓰지 않으므로, 새 규칙에 `display`와 `gap`을 연달아 넣을 때 두 번째 op이 첫 번째가 만든 블록을 이어서 확장한다. (스냅샷 기준으로 계산하면 마지막 선언만 남는다.)

## 테스트

```bash
npm test     # 142개: 스캐너, 편집 엔진, 저널, API, 서버, 호스팅/토큰/폴더 탐색, 프로필/레지스트리, 소유권 판정, 빈 DOM 부트스트랩, 제안 엔진, op 빌더, 브라우저 e2e
```

`tests/edit.test.mjs`는 HTML/CSS 스캐너와 편집 엔진을 덮는다: 바이트 범위 정확성, 범위 밖 바이트 보존, 버전 불일치 거부, op별 가드(`VOID_NODE`, `NOT_A_LEAF`, `NO_RULE`, `BAD_SELECTOR`), CSS 배치 순차 적용, 재스캔 후 롤백.
`tests/foundation.test.mjs`는 Chromium에서 13개 파운데이션(`switch` 포함)의 키보드·포커스·ARIA 동작을 실제 이벤트로 확인한다.
`tests/studio.test.mjs`는 실제 프로젝트를 임시 디렉터리에 복사해 HTTP 왕복까지 검증한다.
`tests/studio.e2e.test.mjs`는 Chromium을 띄워 미리보기 선택 → 폼 편집 → diff 확인 → 디스크 검증과 stale 거부를 실제 UI로 확인한다. Chromium이 없으면 skip한다.
`tests/hosting.test.mjs`는 호스트 바인딩과 토큰 게이트, 폴더 탐색의 탈출 차단, 프로젝트 전환 후 서빙 경로 변경을 덮는다.
`tests/project.test.mjs`는 프로필 수집, 레지스트리(`HF_HOME`으로 격리), `GET /api/profile`, 입력 검증을 덮는다.
`tests/owner.test.mjs`는 마크업/동작/스타일이 서로 다른 파일에 있는 프로젝트에서 소유권 판정을 검증한다.
`tests/bootstrap.test.mjs`는 빈 파일·프래그먼트·`<body />`에 프레임을 적용하고, 스타일시트가 없을 때 생성되는지 검증한다.
`tests/suggest.test.mjs`는 제안 엔진이 지원하는 op만 내보내는지, 계약/접근성/구조 규칙이 오탐 없이 동작하는지, 제안을 적용하면 결함이 실제로 사라지는지 검증한다.

## 라이선스

**AGPL-3.0-only**. 전문은 [LICENSE](LICENSE)에 있다.

네트워크로 이 소프트웨어를 제공하면(수정 여부와 무관하게) 사용자에게 소스 전체를 공개해야 한다 — AGPL 제13조. 스튜디오를 사내 서버나 SaaS로 띄우는 경우도 포함된다.

npm에는 배포하지 않는다. `package.json`이 `private: true`이고, `prepublishOnly`가 배포를 명시적으로 거부한다(npm 11 미만은 `private`를 무시하므로 이중으로 막는다). 설치는 저장소를 클론해서 한다:

```bash
git clone https://github.com/jjigmeok-dev/web-page-helper
cd web-page-helper && npm ci
```
