# 필드 출처 색인

`docs/EDITOR-MEMO.md` §4가 인용하는 클래스의 출처와 인용 위치. 아래 `.txt` 발췌는
**로컬 캐시이며 저장소에 커밋하지 않는다**(`docs/sources/.gitignore`). 원문은 각 URL에서 다시 받는다.

| 출처 | 클래스 | 인용한 구절 | 쓰인 곳 |
| --- | --- | --- | --- |
| https://www.nngroup.com/articles/ten-usability-heuristics/ (2024 개정) | Nielsen #2 Match Between the System and the Real World | "The design should speak the users' language. Use words, phrases, and concepts familiar to the user, rather than internal jargon." | L1 |
| 위 문서 §6 | Nielsen #6 Recognition Rather than Recall | "Minimize the user's memory load by making elements, actions, and options visible." | L2, L3 |
| 위 문서 §4 | Nielsen #4 Consistency and Standards | "Users should not have to wonder whether different words, situations, or actions mean the same thing." | L4 |
| 위 문서 §7 | Nielsen #7 Flexibility and Efficiency of Use | "Shortcuts — hidden from novice users — may speed up the interaction for the expert user so that the design can cater to both inexperienced and experienced users." | L2의 빠른 경로 |
| https://www.nngroup.com/articles/progressive-disclosure/ | 점진적 노출 | "Progressive disclosure defers advanced or rarely used features to a secondary screen, making applications easier to learn and less error-prone." | L1의 경계 |
| https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics | CSS 값 문법 | "CSS … is used to style and layout web pages — for example, to alter the font, color, size, and spacing of your content" | L1의 경계 |

로컬 캐시 재생성 (2026-11-12 수집, HTTP 200):

```bash
curl -sSL -A 'Mozilla/5.0' https://www.nngroup.com/articles/ten-usability-heuristics/ -o /tmp/nng.html
curl -sSL -A 'Mozilla/5.0' https://www.nngroup.com/articles/progressive-disclosure/ -o /tmp/pd.html
curl -sSL -A 'Mozilla/5.0' https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics -o /tmp/mdn.html
```

`nng-heuristics.txt` / `nng-progressive.txt` / `mdn-css-basics.txt`는 위 응답에서
`<script>`·`<style>`·태그를 걷어낸 텍스트다. 인용 판단은 이 파일의 해당 절로 확인한다.
