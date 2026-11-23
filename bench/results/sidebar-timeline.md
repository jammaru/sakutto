# Model-card sidebar: per-block timeline (mock tier c8)

Sentence reveal on `bench/pages/model-card-sidebar.html`. `request`, `token` and
`write` come from the content script clock; `dom` is the recorder polling the page.
`fast` marks a block that gets the above-fold token fast path, `prio` its queue priority.

| Block         | Tag | Kind   | Band    | Fast |  Prio | Request | Token | Write |  DOM |
| ------------- | --- | ------ | ------- | ---- | ----: | ------: | ----: | ----: | ---: |
| logo          | p   | chrome | visible | no   |    50 |     526 |   542 |   554 |  625 |
| nav-models    | li  | chrome | visible | no   |    50 |     526 |   571 |   602 |  675 |
| nav-datasets  | li  | chrome | visible | no   | 50.01 |     526 |   604 |   636 |  700 |
| nav-spaces    | li  | chrome | visible | no   | 50.01 |     526 |   637 |   669 |  750 |
| nav-docs      | li  | chrome | visible | no   | 50.02 |     526 |   671 |   702 |  775 |
| tab-card      | p   | prose  | visible | no   | 50.02 |     526 |   704 |   736 |  800 |
| tab-files     | p   | prose  | visible | no   | 50.02 |     526 |   738 |   769 |  850 |
| tab-community | p   | prose  | visible | no   | 50.03 |     526 |   772 |   802 |  875 |
| tab-settings  | p   | prose  | visible | no   | 50.03 |     554 |   570 |   586 |  650 |
| title         | h1  | prose  | visible | no   | 10.04 |      11 |    31 |    86 |  150 |
| subtitle      | p   | prose  | visible | yes  | 10.04 |      12 |    37 |    37 |  100 |
| tag-1         | li  | prose  | visible | no   | 50.04 |     554 |   600 |   619 |  700 |
| tag-2         | li  | prose  | visible | no   | 50.05 |     554 |   633 |   653 |  725 |
| tag-3         | li  | prose  | visible | no   | 50.05 |     554 |   666 |   686 |  750 |
| tag-4         | li  | prose  | visible | no   | 50.06 |     554 |   696 |   719 |  800 |
| tag-5         | li  | prose  | visible | no   | 50.06 |     554 |   729 |   752 |  825 |
| h2-1          | h2  | prose  | visible | no   | 10.06 |      41 |    57 |    86 |  150 |
| p1            | p   | prose  | visible | yes  | 10.07 |      70 |   107 |   107 |  175 |
| p2            | p   | prose  | visible | no   | 10.07 |      79 |   118 |   169 |  250 |
| h2-2          | h2  | prose  | visible | no   | 10.08 |     185 |   201 |   219 |  300 |
| p3            | p   | prose  | visible | no   | 10.08 |     205 |   246 |   336 |  400 |
| li-1          | li  | prose  | visible | no   | 10.08 |     218 |   236 |   252 |  325 |
| li-2          | li  | prose  | visible | no   | 10.09 |     218 |   269 |   336 |  400 |
| li-3          | li  | prose  | visible | no   | 10.09 |     218 |   307 |   336 |  400 |
| h2-3          | h2  | prose  | visible | no   |  10.1 |     327 |   343 |   452 |  525 |
| p4            | p   | prose  | visible | no   |  10.1 |     334 |   364 |   452 |  525 |
| h2-4          | h2  | prose  | visible | no   |  10.1 |     360 |   377 |   452 |  525 |
| p5            | p   | prose  | visible | no   | 10.11 |     394 |   436 |   569 |  650 |
| p6            | p   | prose  | visible | no   | 10.11 |     420 |   454 |   569 |  650 |
| h2-5          | h2  | prose  | visible | no   | 10.12 |     524 |   541 |   569 |  650 |
| info-title    | h2  | chrome | visible | no   | 50.12 |     743 |   759 |   786 |  850 |
| dt-downloads  | dt  | chrome | visible | no   | 50.12 |     777 |   793 |   819 |  900 |
| dt-size       | dt  | chrome | visible | no   | 50.13 |     777 |   822 |   852 |  925 |
| dd-size       | dd  | chrome | visible | no   | 50.13 |     777 |   855 |   886 |  950 |
| dt-tensor     | dt  | chrome | visible | no   | 50.14 |     777 |   889 |   919 | 1000 |
| dd-tensor     | dd  | chrome | visible | no   | 50.14 |     777 |   923 |   936 | 1000 |
| dt-updated    | dt  | chrome | visible | no   | 50.14 |     777 |   954 |   987 | 1050 |
| dd-updated    | dd  | chrome | visible | no   | 50.15 |     777 |   992 |  1019 | 1100 |
| dt-license    | dt  | chrome | visible | no   | 50.15 |     777 |  1026 |     - | 1125 |
| dd-license    | dd  | chrome | visible | no   | 50.16 |     790 |   807 |   836 |  900 |
| mi-1          | p   | chrome | visible | no   | 50.16 |     790 |   838 |   852 |  925 |
| mi-2          | p   | chrome | visible | no   | 50.16 |     790 |   867 |   886 |  950 |
| mi-3          | p   | chrome | visible | no   | 50.17 |     790 |   896 |   919 | 1000 |
| mi-4          | p   | chrome | visible | no   | 50.17 |     790 |   925 |   953 | 1025 |

First visible text: 100 ms; first painted word: request 11 / ttfb 20 / paint 7 ms.
