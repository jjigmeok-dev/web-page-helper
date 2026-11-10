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
| `accordion` | `div` + `button` + ARIA | — | **유지 중** (아래 참고) |
| `tabs` | `role="tablist"` + roving tabindex | — | **유지 중** |
| `switch` | `role="switch"` + `aria-checked` | `switch-control` **limited** | 수동 유지가 맞음 |
| `popover` | `div` + `position` | `popover` **newly** | 단계적 전환 후보 |
| `menu` | `div` + ARIA menu 패턴 | `popover` 부품 **newly** | 유지 |
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

### 왜 `accordion`은 아직 안 바꿨나

가이드는 `<details name="...">`를 권한다. `details`는 widely지만 `details-name`은 **newly**(2024-09-03)다.
단일 확장(`type: 'single'`)을 `name`으로 처리하려면 `details-name`이 필요한데, 이 프로젝트는 의존성 없는 무빌드를 표방하므로
폴리필 없이 넘어가면 구형 브라우저에서 다중 확장으로 동작한다.
**전환 조건**: `details-name` widely 도달, 또는 `name` 미지원 시 기존 ARIA 경로로 폴백하는 이중 경로 구현.

### 왜 `switch`는 수동이 맞나

`switch-control`(`<input type="checkbox" switch>`)은 **Safari 17.4 전용**이다.
이걸 쓰면 Chrome·Firefox에서 그냥 체크박스로 보인다. `role="switch"` + `aria-checked` 수동 구현이 현재로선 옳다.

---

## 2. 채택 가능한 API (실측)

`web-features` 데이터 기준. 날짜는 주요 브라우저 전체 지원 시점.

| 기능 | 상태 | 하한 | 비고 |
|---|---|---|---|
| `dialog` | **widely** | 2022-03-14 | ✅ 사용 중 |
| `details` | **widely** | 2020-01-15 | 미사용 |
| `:has()` | **widely** | 2023-12-19 | 스튜디오 CSS에서 사용 |
| `popover` | newly | 2025-01-27 | 전환 후보 |
| `invoker-commands` (`commandfor`) | newly | 2025-12-12 | 전환 후보 |
| `field-sizing: content` | newly | 2026-06-16 | textarea 자동 높이 대체 |
| `scrollbar-color` | newly | 2025-12-12 | `::-webkit-scrollbar` 대체 |
| `transition-behavior` | newly | 2024-08-06 | top layer 등장/퇴장 애니메이션 |
| `view-transitions` | newly | 2025-10-14 | — |
| `details-name` | newly | 2024-09-03 | accordion 전환 조건 |

**폴백 없이 쓰면 안 되는 것 (limited):**

| 기능 | 지원 현황 | 대체 |
|---|---|---|
| `move-before` | Chrome 133+, Firefox 144+, **Safari 미지원** | `before()` + 포커스/캡처 복구 |
| `switch-control` | **Safari 전용** | `role="switch"` |
| `interest-invokers` (`interestfor`) | Chrome 149+ | `mouseenter`/`focusin` |
| `anchor-positioning` | Safari 27+ | 수동 좌표 계산 |
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
`moveBefore()`가 widely가 되면 상태를 보존한 채 옮길 수 있다.

---

## 5. 다음 전환 후보

우선순위는 **효과 / 위험** 비율.

1. **`popover` + `commandfor`** (newly) — `popover.js`·`menu.js`의 outside-click·Escape·포커스 복원 배선을
   브라우저에 넘길 수 있다. `popover`가 widely에 가까워지면 진행. 단 `focusgroup`은 limited라 roving tabindex는 유지.
2. **`details-name`** (newly) — accordion 전환. 폴백 경로가 필요.
3. **`field-sizing: content`** (newly) — 스튜디오 textarea 자동 높이.
4. **`moveBefore()`** (limited) — 프리뷰 리로드 제거. Safari 지원 후.

각 항목은 **폴백 경로가 먼저 있고 그 다음 채택**이다. 폴백 없는 채택은 하지 않는다.

---

## 참고

- [Modern Web Guidance 문서](https://developer.chrome.com/docs/modern-web-guidance)
- [Baseline](https://web-platform-dx.github.io/web-features/)
- `npx modern-web-guidance@latest search "<주제>"` — 관련 가이드 검색
- `npx modern-web-guidance@latest legacy-scan .` — 레거시 패턴 스캔
  (33개 가이드만 커버하므로 0건이 "문제 없음"을 뜻하지 않는다. 수동 대조 병행)
