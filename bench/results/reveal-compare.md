# Reveal mode comparison (mock tier c8)

`main` is the pre-reveal streaming build; `smooth` and `sentence` are this branch.
Mock pace: 12 ms prefill, 0.35 ms per character, 3 deltas. Sentence rows are medians of 3 samples; times are milliseconds.

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
| long-article                   | sentence |           125 |      1777 | 0.0321 |             6 |
| first-paragraph-then-long-tail | sentence |           100 |      1425 | 0.0318 |             4 |
| many-cards                     | sentence |           100 |      1225 | 0.0336 |             7 |
| mixed-ui                       | sentence |           125 |       975 | 0.0318 |             6 |
| single-long-paragraph          | sentence |           150 |      1125 | 0.0316 |             1 |
| model-card-sidebar             | sentence |           125 |      1125 | 0.0325 |            11 |
| headline-in-header             | sentence |           150 |      1125 | 0.0322 |             6 |
| late-mount-spa                 | sentence |           125 |      1625 | 0.0317 |             5 |
