# Model-card sidebar: per-block timeline (mock tier c8)

Sentence reveal on `bench/pages/model-card-sidebar.html`. `request`, `token` and
`write` come from the content script clock; `dom` is the recorder polling the page.
`fast` marks a block that gets the above-fold token fast path, `prio` its queue priority.

| Block         | Tag | Kind   | Band    | Fast |  Prio | Request | Token | Write |  DOM |
| ------------- | --- | ------ | ------- | ---- | ----: | ------: | ----: | ----: | ---: |
| logo          | p   | chrome | visible | no   |    50 |     527 |   544 |   556 |  650 |
| nav-models    | li  | chrome | visible | no   |    50 |     527 |   572 |   601 |  700 |
| nav-datasets  | li  | chrome | visible | no   | 50.01 |     527 |   606 |   634 |  725 |
| nav-spaces    | li  | chrome | visible | no   | 50.01 |     527 |   640 |   667 |  750 |
| nav-docs      | li  | chrome | visible | no   | 50.02 |     527 |   673 |   700 |  800 |
| tab-card      | p   | prose  | visible | no   | 50.02 |     527 |   706 |   734 |  825 |
| tab-files     | p   | prose  | visible | no   | 50.02 |     527 |   739 |   767 |  850 |
| tab-community | p   | prose  | visible | no   | 50.03 |     527 |   773 |   800 |  900 |
| tab-settings  | p   | prose  | visible | no   | 50.03 |     556 |   572 |   601 |  700 |
| title         | h1  | prose  | visible | no   | 10.04 |      12 |    31 |    32 |  125 |
| subtitle      | p   | prose  | visible | yes  | 10.04 |      12 |    37 |    38 |  125 |
| tag-1         | li  | prose  | visible | no   | 50.04 |     556 |   602 |   634 |  725 |
| tag-2         | li  | prose  | visible | no   | 50.05 |     556 |   636 |   667 |  750 |
| tag-3         | li  | prose  | visible | no   | 50.05 |     556 |   669 |   684 |  775 |
| tag-4         | li  | prose  | visible | no   | 50.06 |     556 |   698 |   717 |  800 |
| tag-5         | li  | prose  | visible | no   | 50.06 |     556 |   731 |   750 |  850 |
| h2-1          | h2  | prose  | visible | no   | 10.06 |      43 |    59 |    59 |  150 |
| p1            | p   | prose  | visible | yes  | 10.07 |      73 |   109 |   109 |  200 |
| p2            | p   | prose  | visible | no   | 10.07 |      78 |   117 |   118 |  200 |
| h2-2          | h2  | prose  | visible | no   | 10.08 |     187 |   204 |   204 |  300 |
| p3            | p   | prose  | visible | no   | 10.08 |     204 |   245 |   245 |  350 |
| li-1          | li  | prose  | visible | no   | 10.08 |     222 |   239 |   239 |  325 |
| li-2          | li  | prose  | visible | no   | 10.09 |     222 |   272 |   273 |  375 |
| li-3          | li  | prose  | visible | no   | 10.09 |     222 |   310 |   310 |  400 |
| h2-3          | h2  | prose  | visible | no   |  10.1 |     330 |   347 |   347 |  450 |
| p4            | p   | prose  | visible | no   |  10.1 |     334 |   364 |   364 |  450 |
| h2-4          | h2  | prose  | visible | no   |  10.1 |     364 |   380 |   380 |  475 |
| p5            | p   | prose  | visible | no   | 10.11 |     398 |   439 |   439 |  525 |
| p6            | p   | prose  | visible | no   | 10.11 |     420 |   454 |   454 |  550 |
| h2-5          | h2  | prose  | visible | no   | 10.12 |     525 |   542 |   542 |  625 |
| info-title    | h2  | chrome | visible | no   | 50.12 |     744 |   760 |   760 |  850 |
| dt-downloads  | dt  | chrome | visible | no   | 50.12 |     777 |   793 |   817 |  900 |
| dt-size       | dt  | chrome | visible | no   | 50.13 |     777 |   823 |   850 |  950 |
| dd-size       | dd  | chrome | visible | no   | 50.13 |     777 |   856 |   884 |  975 |
| dt-tensor     | dt  | chrome | visible | no   | 50.14 |     777 |   890 |   917 | 1000 |
| dd-tensor     | dd  | chrome | visible | no   | 50.14 |     777 |   923 |   951 | 1050 |
| dt-updated    | dt  | chrome | visible | no   | 50.14 |     777 |   952 |   984 | 1075 |
| dd-updated    | dd  | chrome | visible | no   | 50.15 |     777 |   989 |  1017 | 1100 |
| dt-license    | dt  | chrome | visible | no   | 50.15 |     777 |  1023 |     - | 1150 |
| dd-license    | dd  | chrome | visible | no   | 50.16 |     790 |   806 |   834 |  925 |
| mi-1          | p   | chrome | visible | no   | 50.16 |     790 |   836 |   850 |  950 |
| mi-2          | p   | chrome | visible | no   | 50.16 |     790 |   864 |   884 |  975 |
| mi-3          | p   | chrome | visible | no   | 50.17 |     790 |   893 |   917 | 1000 |
| mi-4          | p   | chrome | visible | no   | 50.17 |     790 |   923 |   951 | 1050 |

First visible text: 125 ms; first painted word: request 12 / ttfb 20 / paint 0 ms.
