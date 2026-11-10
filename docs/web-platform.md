# 웹 플랫폼 기준

이 프로젝트가 어떤 웹 API를 쓰고, 왜 쓰고, 무엇을 쓰지 않는지에 대한 근거.
판단 기준은 [Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance-src)(Google Chrome·Microsoft Edge·Mozilla Firefox·MDN 공동 관리)와
[`web-features`](https://www.npmjs.com/package/web-features)의 Baseline 데이터다.

**원칙은 하나다: 브라우저가 이미 하는 일을 자바스크립트로 다시 짜지 않는다.**

Baseline 상태는 세 단계다.

| 상태 | 의미 |
|---|---|
| **widely** | 주요 브라우저에서 30개월 이상 동작. 조건 없이 사용 |
| **newly** | 모든 주요 브라우저에서 동작하지만 30개월 미만. 사용하되 대체 동작 확인 |
| **limited** | 일부 브라우저 미지원. **폴백 필수**, 없으면 사용하지 않음 |

---

## 1. 파운데이션별 결정

| 파운데이션 | 기반 | Baseline | 결정 |
|---|---|---|---|
| `dialog` | `<dialog>` + `showModal()` | **widely** (2022-03-14) | 네이티브 사용. 수동 포커스 트랩 제거 |
| `accordion` | `<details name>` / `div` + `button` + ARIA | `details-name` **newly** | **이중 경로**: 마크업이 `<details>`면 네이티브 |
| `tabs` | `role="tablist"` + roving tabindex | — | **유지 중** |
| `switch` | `role="switch"` + `aria-checked` | `switch-control` **limited** | 수동 유지가 맞음 |
| `popover` | `popover` + `commandfor` (앵커는 anchor positioning) | `popover` **newly** | **네이티브 채택**, 미지원 시 인플로우 폴백 |
| `menu` | `popover` + `commandfor` + roving tabindex | `popover` **newly** | **네이티브 채택** (클리핑 실측 후) |
| `tooltip` | `aria-describedby` | `interestfor` **limited** | 수동 유지가 맞음 |

### 왜 `dialog`를 바꿨나

이전 구현은 `role="dialog"`, `aria-modal`, `trapTab()`, `keydown` Escape 핸들러, 스크롤 락, 포커스 복원을 **직접** 했다.
가이드는 이 넷을 명시적으로 금지한다.

> **DON'T** add `role="dialog"`, `aria-modal`, a focus trap, `inert` toggling or an `Esc` handler.
> **DON'T** write code to return focus on close. The browser returns it to the invoker.
> **DON'T** lock scrolling with `overflow: hidden` or `position: fixed` on `html` or `body`.

`showModal()`이 주는 것:

- top layer 렌더링 (`z-index` 없이 페이지 위에 뜸)
- 페이지 `inert` 처리
- 포커스 가둠 + 닫을 때 **호출한 요소로 자동 복귀**
- `Esc`와 모바일 뒤로가기 제스처
- `::backdrop` 가상 요소

131줄 → 141줄이지만, **직접 구현한 동작이 0**이다. 남은 코드는 API·옵션·이벤트 배선뿐이다.

남긴 핸들러는 두 개고, 둘 다 플랫폼이 결정할 수 없는 것이다.

| 핸들러 | 이유 |
|---|---|
| `cancel` | `closeOnEscape: false`일 때만 `preventDefault()`. 옵션이므로 플랫폼이 모름 |
| `click` (target === dialog) | 백드롭 클릭. `closedby`가 **limited**라 폴백이 필요 |

### 왜 `accordion`은 마크업에 따라 갈라지나

`<details name>`은 배타 확장·키보드 활성화·상태 노출을 **플랫폼이** 처리하고, JS가 없어도 열린다.
반면 `summary`로 표현할 수 없는 레이아웃(제목 안에 배지·버튼이 섞인 경우 등)이 있다.
그래서 전환은 **마크업이 결정**한다: `[data-hf-part="item"]`이 `<details>`면 네이티브, 아니면 기존 ARIA 경로다.
한 아코디언에서 섞으면 `type: 'single'`의 진실 공급원이 둘이 되므로 `mount()`가 거부한다.

실측으로 확인한 제약 셋:

| 제약 | 실측 | 처리 |
|---|---|---|
| `toggle`은 취소할 수 없음 | `beforetoggle` 없음, `preventDefault()` 무효 | `collapsible: false`는 `toggle` 안에서 `open = true`로 되돌림 (같은 태스크, 페인트 전) |
| 프로그램적 `open`은 `toggle`을 쏘지 않음 | 리스너 로그 빈 배열 | API 경로는 이벤트에 의존하지 않고 직접 상태를 반영 |
| `name` 미지원이면 배타가 사라짐 | 프로토타입에서 `name` 삭제 → 둘 다 열림 | 같은 루프가 형제를 닫아 준다 (테스트로 고정) |

`hidden`은 `<details>`에서 쓰지 않는다. 닫힌 콘텐츠는 UA가 이미 렌더링하지 않으므로,
`hidden`을 걸면 `open` 속성과 상태가 둘로 갈라진다.

### 왜 `switch`는 수동이 맞나

`switch-control`(`<input type="checkbox" switch>`)은 **Safari 17.4 전용**이다.
이걸 쓰면 Chrome·Firefox에서 그냥 체크박스로 보인다. `role="switch"` + `aria-checked` 수동 구현이 현재로선 옳다.

---

## 2. 채택 가능한 API (실측)

`web-features` 데이터 기준. 날짜는 주요 브라우저 전체 지원 시점.

| 기능 | 상태 | 하한 | 비고 |
|---|---|---|---|
| `dialog` | **widely** | 2022-03-14 | ✅ 사용 중 |
| `details` | **widely** | 2020-01-15 | ✅ 사용 중 (accordion 네이티브 경로) |
| `:has()` | **widely** | 2023-12-19 | 스튜디오 CSS에서 사용 |
| `popover` | newly | 2025-01-27 | ✅ 사용 중 (popover·menu) |
| `invoker-commands` (`commandfor`) | newly | 2025-12-12 | ✅ 사용 중 (팝오버 열고 닫기) |
| `field-sizing: content` | newly | 2026-06-16 | ✅ 사용 중 (스튜디오 값 입력) |
| `details-name` | newly | 2024-09-03 | ✅ 사용 중 (accordion 단일 확장) |
| `scrollbar-color` | newly | 2025-12-12 | `::-webkit-scrollbar` 대체 |
| `transition-behavior` | newly | 2024-08-06 | top layer 등장/퇴장 애니메이션 |
| `view-transitions` | newly | 2025-10-14 | — |

**폴백 없이 쓰면 안 되는 것 (limited):**

| 기능 | 지원 현황 | 대체 |
|---|---|---|
| `move-before` | Chrome 133+, Firefox 144+, **Safari 미지원** | `before()` + 포커스/캡처 복구. 이 스튜디오는 적용 지점 없음 (아래 4.3) |
| `switch-control` | **Safari 전용** | `role="switch"` |
| `interest-invokers` (`interestfor`) | Chrome 149+ | `mouseenter`/`focusin` |
| `anchor-positioning` | Safari 27+ | 팝오버를 승격하지 않고 인플로우로 유지 |
| `focusgroup` | Chrome 150+ | roving tabindex |
| `hidden-until-found` | Safari 미지원 | `hidden` |
| `dialog-closedby` | Chrome 134+, Firefox 141+ | `cancel` + 클릭 핸들러 |
| `customizable-select` | Chrome 135+, Safari 27+ | 네이티브 `<select>` |
| `interpolate-size` | Chrome 129+ | 고정 높이 트랜지션 |

---

## 3. headless 계약과 플랫폼의 관계

파운데이션은 `class`·`style`·`<style>`을 절대 쓰지 않는다 (`npm run validate`가 강제).

이 제약은 플랫폼 API와 충돌하지 않는다. 네이티브 요소는 **동작과 접근성을 속성으로** 노출하기 때문이다.

| 네이티브가 주는 것 | 파운데이션이 하는 것 |
|---|---|
| `<dialog>`의 top layer·포커스·Esc | `open()`/`close()`/`toggle()` API와 `hf:open`/`hf:close` 이벤트 |
| `popover`의 top layer·light dismiss·Esc·포커스 복귀 | 같은 API/이벤트. 상태 미러링만 직접 |
| `<details>`의 열림 상태·배타(`name`)·키보드 활성화 | 같은 API/이벤트. `open`을 진실로 삼음 |
| `[open]` 속성으로 상태 노출 | `data-state="open"` 미러링 (소비자 CSS 훅) |
| `::backdrop` | 소비자가 `dialog::backdrop`으로 스타일 |

즉 **동작은 플랫폼에, 모양은 소비자에게**. 이 분업이 headless 패턴의 원래 의도다.

---

## 4. 스튜디오에서 지킨 규칙

스튜디오도 같은 원칙을 따른다. 두 가지가 특히 가이드와 직결된다.

### 4.1 CSSOM은 `var()` 셔틀랜드를 펼치지 못한다

`background: var(--hf-surface-2)` 같은 **pending-substitution** 값은
`rule.style`이 롱핸드별로 빈 문자열을 보고한다.

```js
rule.style.cssText  // "background: var(--hf-surface-2)"
rule.style.length   // 여러 롱핸드로 쪼개져 있고 전부 ""
```

롱핸드 단위로 스냅샷·복원하면 그 선언이 **삭제**된다. 실제로 아무 요소나 편집하면
`body` 배경이 사라져 화면이 하얘지는 버그가 있었다.
해결: 규칙은 `cssText` 단위로 스냅샷한다. 왕복이 보존된다.

### 4.2 구조 편집은 CSSOM으로 표현할 수 없다

선언·속성·텍스트는 로드된 문서에 직접 반영된다.
이동·삽입·삭제는 문서 **모양**을 바꾸므로 그런 경로가 없다.

해결: pending op을 **메모리에서** 적용한 문서를 `/__api/preview`로 받아 다시 그린다.
디스크는 건드리지 않는다. 노드 id가 구조 경로라 이동 시 번호가 바뀌므로
트리도 같은 문서 기준으로 다시 만들고, 선택은 태그·속성·텍스트 지문으로 재해석한다.

**트레이드오프**: 구조 편집 시 iframe이 리로드되어 페이지 스크립트 상태(열린 아코디언 등)가 초기화된다.
스크롤 위치는 `scroll-to` 브리지 메시지로 복원한다. 선택은 지문으로 재해석하므로 유지된다.

### 4.3 `moveBefore()`는 여기에 적용 지점이 없다

`moveBefore()`는 DOM 노드를 옮기면서 iframe·동영상·포커스 같은 **살아있는 상태**를 보존한다.
이 스튜디오에는 그런 이동이 없다.

- `moveNode`는 DOM 조작이 아니라 **소스 텍스트 편집**이다 (`tools/studio/edit.mjs`).
  이동 = 원본 구간 제거 + 목적지 삽입이고, 결과는 파일에 기록된다.
- 프리뷰는 서버가 만든 문서를 iframe `src`로 통째 교체한다. 옮길 노드가 DOM에 남아 있지 않다.

따라서 `moveBefore()`를 쓸 수 있는 곳이 없다. 리로드를 없애려면 구조 편집을
"문서 재생성"이 아니라 "살아있는 DOM 패치"로 바꿔야 하고, 그건 편집 모델 자체를 바꾸는 일이다.
`moveBefore` 지원 여부와 무관한 결정이므로 전환 후보에서 뺀다.

---

## 5. 다음 전환 후보

우선순위는 **효과 / 위험** 비율.

완료된 전환은 1절 표에 반영했다. 남은 후보:

1. **`transition-behavior`** (newly) — top layer 요소(`dialog`, `popover`)의 등장/퇴장 애니메이션.
   지금은 즉시 나타나고 사라진다. `@starting-style`과 함께 써야 하므로 별도 작업.
2. **`scrollbar-color`** (newly) — `::-webkit-scrollbar` 대체.
3. **`focusgroup`** (Chrome 150+) — roving tabindex 대체. 아직 limited라 보류.

각 항목은 **폴백 경로가 먼저 있고 그 다음 채택**이다. 폴백 없는 채택은 하지 않는다.
`moveBefore()`는 4.3의 이유로 후보에서 제외했다.

---

## 참고

- [Modern Web Guidance 문서](https://developer.chrome.com/docs/modern-web-guidance)
- [Baseline](https://web-platform-dx.github.io/web-features/)
- `npx modern-web-guidance@latest search "<주제>"` — 관련 가이드 검색
- `npx modern-web-guidance@latest legacy-scan .` — 레거시 패턴 스캔
  (33개 가이드만 커버하므로 0건이 "문제 없음"을 뜻하지 않는다. 수동 대조 병행)
