# Reveal mode comparison (mock tier c8)

`main` is the pre-reveal streaming build; `smooth` and `sentence` are this branch.
Mock pace: 12 ms prefill, 0.35 ms per character, 3 deltas. Times are milliseconds.

| Page                           | Mode     | First visible | Full page |    CLS | Layout shifts |
| ------------------------------ | -------- | ------------: | --------: | -----: | ------------: |
| long-article                   | main     |           125 |      1750 | 0.1396 |            23 |
| first-paragraph-then-long-tail | main     |           100 |      1400 | 0.1212 |            20 |
| many-cards                     | main     |           126 |      1300 | 0.0988 |            33 |
| mixed-ui                       | main     |           125 |      1025 | 0.0818 |            16 |
| long-article                   | smooth   |           175 |      1752 | 0.0319 |             5 |
| first-paragraph-then-long-tail | smooth   |           150 |      1400 | 0.0317 |             3 |
| many-cards                     | smooth   |           150 |      1325 | 0.0336 |             7 |
| mixed-ui                       | smooth   |           175 |      1075 | 0.0318 |             6 |
| long-article                   | sentence |           125 |      1800 | 0.1045 |            17 |
| first-paragraph-then-long-tail | sentence |           125 |      1400 | 0.0466 |             9 |
| many-cards                     | sentence |           100 |      1300 |  0.091 |            24 |
| mixed-ui                       | sentence |           125 |      1050 | 0.0542 |            11 |
