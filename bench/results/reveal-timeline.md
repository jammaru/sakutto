# Reveal first-paint timelines (mock tier c8)

Sentence reveal on the four first-paint fixtures. Request, token and write
come from the content script clock; dom is the recorder polling the page. Fast
marks a block with an above-fold token fast-path slot, prio its queue priority.
A visible block whose write equals its token painted in the decode turn.

## long-article

First visible text: 125 ms; first painted word: request 12 / ttfb 19 / paint 0 ms.

| Block           | Tag        | Kind   | Band    | Fast |  Prio | Request | Token | Write |  DOM |
| --------------- | ---------- | ------ | ------- | ---- | ----: | ------: | ----: | ----: | ---: |
| s1              | span       | chrome | visible | no   |    50 |    1324 |  1340 |  1357 |    - |
| nav-1           | li         | chrome | visible | no   |    50 |    1324 |  1373 |  1387 | 1450 |
| nav-2           | li         | chrome | visible | no   | 50.01 |    1324 |  1403 |  1421 | 1500 |
| nav-3           | li         | chrome | visible | no   | 50.01 |    1324 |  1431 |  1454 | 1525 |
| nav-4           | li         | chrome | visible | no   | 50.02 |    1324 |  1460 |  1487 | 1550 |
| nav-5           | li         | chrome | visible | no   | 50.02 |    1324 |  1493 |  1520 | 1600 |
| nav-6           | li         | chrome | visible | no   | 50.02 |    1324 |  1522 |  1554 | 1625 |
| title           | h1         | prose  | visible | no   | 10.03 |      12 |    31 |    32 |  100 |
| standfirst      | p          | prose  | visible | yes  | 10.03 |      13 |    46 |    46 |  125 |
| p1              | p          | prose  | visible | yes  | 10.04 |      46 |    87 |    88 |  150 |
| p2              | p          | prose  | visible | no   | 10.04 |      93 |   132 |   132 |  200 |
| h2-1            | h2         | prose  | visible | no   | 10.04 |     181 |   197 |   197 |  275 |
| p3              | p          | prose  | visible | no   | 10.05 |     210 |   258 |   258 |  325 |
| p4              | p          | prose  | visible | no   | 10.05 |     219 |   258 |   258 |  325 |
| p5              | p          | prose  | visible | no   | 10.06 |     341 |   380 |   381 |  450 |
| quote           | blockquote | prose  | visible | no   | 10.06 |     355 |   378 |   378 |  450 |
| h2-2            | h2         | prose  | visible | no   | 10.06 |     413 |   430 |   430 |  500 |
| p6              | p          | prose  | visible | no   | 10.07 |     443 |   486 |   486 |  550 |
| p7              | p          | prose  | visible | no   | 10.07 |     464 |   505 |   505 |  575 |
| p8              | p          | prose  | visible | no   | 10.08 |     585 |   619 |   619 |  700 |
| figure          | figure     | chrome | visible | no   | 50.08 |    1324 |  1566 |  1604 | 1675 |
| h2-3            | h2         | prose  | visible | no   | 10.08 |     594 |   610 |   610 |  675 |
| p9              | p          | prose  | visible | no   | 10.09 |     623 |   666 |   666 |  750 |
| p10             | p          | prose  | visible | no   | 10.09 |     691 |   728 |   728 |  800 |
| p11             | p          | prose  | visible | no   |  10.1 |     761 |   799 |   799 |  875 |
| h2-4            | h2         | prose  | far     | no   |  34.1 |     805 |   821 |   904 |  975 |
| p12             | p          | prose  | far     | no   |  34.1 |     838 |   875 |   904 |  975 |
| p13             | p          | prose  | far     | no   | 34.11 |     883 |   920 |  1020 | 1100 |
| p14             | p          | prose  | far     | no   | 34.11 |     948 |   987 |  1020 | 1100 |
| p15             | p          | prose  | far     | no   | 34.12 |    1000 |  1040 |  1137 | 1200 |
| p16             | p          | prose  | far     | no   | 34.12 |    1073 |  1112 |  1254 | 1325 |
| p17             | p          | prose  | far     | no   | 34.12 |    1130 |  1169 |  1254 | 1325 |
| p18             | p          | prose  | far     | no   | 34.13 |    1199 |  1239 |  1370 | 1450 |
| p19             | p          | prose  | far     | no   | 34.13 |    1255 |  1293 |  1370 | 1450 |
| rail-title      | h3         | chrome | visible | no   | 50.14 |    1376 |  1393 |  1393 | 1475 |
| rail-1          | li         | chrome | visible | no   | 50.14 |    1410 |  1426 |  1454 | 1525 |
| rail-2          | li         | chrome | visible | no   | 50.14 |    1410 |  1455 |  1471 | 1550 |
| rail-3          | li         | chrome | visible | no   | 50.15 |    1410 |  1484 |  1504 | 1575 |
| rail-4          | li         | chrome | visible | no   | 50.15 |    1410 |  1513 |  1537 | 1600 |
| rail-5          | li         | chrome | visible | no   | 50.16 |    1410 |  1546 |  1570 | 1650 |
| rail-data-title | h3         | chrome | visible | no   | 50.16 |    1564 |  1580 |  1580 | 1650 |
| rail-d1         | li         | chrome | visible | no   | 50.16 |    1597 |  1613 |  1637 | 1700 |
| rail-d2         | li         | chrome | visible | no   | 50.17 |    1597 |  1646 |  1671 | 1750 |
| rail-d3         | li         | chrome | visible | no   | 50.17 |    1597 |  1676 |     - | 1775 |
| foot-1          | p          | chrome | far     | no   | 74.18 |    1612 |  1628 |  1671 | 1750 |

## model-card-sidebar

First visible text: 100 ms; first painted word: request 11 / ttfb 20 / paint 1 ms.

| Block         | Tag | Kind   | Band    | Fast |  Prio | Request | Token | Write |  DOM |
| ------------- | --- | ------ | ------- | ---- | ----: | ------: | ----: | ----: | ---: |
| logo          | p   | chrome | visible | no   |    50 |     533 |   549 |   563 |  625 |
| nav-models    | li  | chrome | visible | no   |    50 |     533 |   579 |   605 |  675 |
| nav-datasets  | li  | chrome | visible | no   | 50.01 |     533 |   612 |   639 |  700 |
| nav-spaces    | li  | chrome | visible | no   | 50.01 |     533 |   645 |   672 |  750 |
| nav-docs      | li  | chrome | visible | no   | 50.02 |     533 |   678 |   705 |  775 |
| tab-card      | p   | prose  | visible | no   | 50.02 |     533 |   711 |   739 |  800 |
| tab-files     | p   | prose  | visible | no   | 50.02 |     533 |   744 |   772 |  850 |
| tab-community | p   | prose  | visible | no   | 50.03 |     533 |   777 |   805 |  875 |
| tab-settings  | p   | prose  | visible | no   | 50.03 |     558 |   574 |   589 |  650 |
| title         | h1  | prose  | visible | no   | 10.04 |      11 |    31 |    32 |  100 |
| subtitle      | p   | prose  | visible | yes  | 10.04 |      11 |    43 |    43 |  100 |
| tag-1         | li  | prose  | visible | no   | 50.04 |     558 |   604 |   622 |  700 |
| tag-2         | li  | prose  | visible | no   | 50.05 |     558 |   637 |   655 |  725 |
| tag-3         | li  | prose  | visible | no   | 50.05 |     558 |   670 |   689 |  750 |
| tag-4         | li  | prose  | visible | no   | 50.06 |     558 |   698 |   722 |  800 |
| tag-5         | li  | prose  | visible | no   | 50.06 |     558 |   732 |   755 |  825 |
| h2-1          | h2  | prose  | visible | no   | 10.06 |      43 |    60 |    60 |  125 |
| p1            | p   | prose  | visible | yes  | 10.07 |      74 |   111 |   111 |  175 |
| p2            | p   | prose  | visible | no   | 10.07 |      84 |   123 |   123 |  200 |
| h2-2          | h2  | prose  | visible | no   | 10.08 |     189 |   206 |   206 |  275 |
| p3            | p   | prose  | visible | no   | 10.08 |     210 |   252 |   252 |  325 |
| li-1          | li  | prose  | visible | no   | 10.08 |     224 |   242 |   242 |  300 |
| li-2          | li  | prose  | visible | no   | 10.09 |     224 |   275 |   275 |  350 |
| li-3          | li  | prose  | visible | no   | 10.09 |     224 |   312 |   312 |  375 |
| h2-3          | h2  | prose  | visible | no   |  10.1 |     333 |   349 |   349 |  425 |
| p4            | p   | prose  | visible | no   |  10.1 |     341 |   371 |   371 |  450 |
| h2-4          | h2  | prose  | visible | no   |  10.1 |     366 |   382 |   382 |  450 |
| p5            | p   | prose  | visible | no   | 10.11 |     399 |   441 |   441 |  500 |
| p6            | p   | prose  | visible | no   | 10.11 |     426 |   461 |   461 |  525 |
| h2-5          | h2  | prose  | visible | no   | 10.12 |     529 |   545 |   545 |  625 |
| info-title    | h2  | chrome | visible | no   | 50.12 |     745 |   761 |   761 |  825 |
| dt-downloads  | dt  | chrome | visible | no   | 50.12 |     778 |   794 |   822 |  900 |
| dt-size       | dt  | chrome | visible | no   | 50.13 |     778 |   824 |   856 |  925 |
| dd-size       | dd  | chrome | visible | no   | 50.13 |     778 |   859 |   889 |  950 |
| dt-tensor     | dt  | chrome | visible | no   | 50.14 |     778 |   892 |   922 | 1000 |
| dd-tensor     | dd  | chrome | visible | no   | 50.14 |     778 |   925 |   939 | 1000 |
| dt-updated    | dt  | chrome | visible | no   | 50.14 |     778 |   954 |   989 | 1050 |
| dd-updated    | dd  | chrome | visible | no   | 50.15 |     778 |   991 |  1022 | 1100 |
| dt-license    | dt  | chrome | visible | no   | 50.15 |     778 |  1024 |     - | 1125 |
| dd-license    | dd  | chrome | visible | no   | 50.16 |     794 |   811 |   839 |  900 |
| mi-1          | p   | chrome | visible | no   | 50.16 |     794 |   841 |   856 |  925 |
| mi-2          | p   | chrome | visible | no   | 50.16 |     794 |   869 |   889 |  950 |
| mi-3          | p   | chrome | visible | no   | 50.17 |     794 |   898 |   922 | 1000 |
| mi-4          | p   | chrome | visible | no   | 50.17 |     794 |   928 |   956 | 1025 |

## single-long-paragraph

First visible text: 150 ms; first painted word: request 6 / ttfb 18 / paint 0 ms.

| Block  | Tag | Kind  | Band    | Fast |  Prio | Request | Token | Write | DOM |
| ------ | --- | ----- | ------- | ---- | ----: | ------: | ----: | ----: | --: |
| title  | h1  | prose | visible | no   |    10 |       6 |    23 |    24 | 100 |
| byline | p   | prose | visible | no   |    50 |      36 |    53 |    69 | 150 |
| p-long | p   | prose | visible | yes  | 10.01 |       8 |    72 |    73 | 150 |

## late-mount-spa

First visible text: 100 ms; first painted word: request 7 / ttfb 18 / paint 1 ms.

| Block     | Tag | Kind   | Band    | Fast |  Prio | Request | Token | Write |  DOM |
| --------- | --- | ------ | ------- | ---- | ----: | ------: | ----: | ----: | ---: |
| brand     | p   | chrome | visible | no   |    50 |     114 |   131 |   148 |  225 |
| nav-1     | li  | chrome | visible | no   |    50 |     114 |   164 |   219 |  275 |
| nav-2     | li  | chrome | visible | no   | 50.01 |     114 |   197 |   219 |  275 |
| nav-3     | li  | chrome | visible | no   | 50.01 |     114 |   231 |   252 |  325 |
| title     | h1  | prose  | visible | no   | 10.02 |       7 |    25 |    25 |  100 |
| p1        | p   | prose  | visible | yes  | 10.02 |       8 |    44 |    44 |  100 |
| p2        | p   | prose  | visible | yes  | 10.02 |      42 |    75 |    75 |  150 |
| h2-late   | h2  | prose  | visible | no   | 10.03 |    1253 |  1268 |  1268 | 1325 |
| p3        | p   | prose  | visible | no   | 10.03 |    1253 |  1286 |  1286 | 1350 |
| li-1      | li  | prose  | visible | no   | 10.04 |    1285 |  1308 |  1308 | 1375 |
| li-2      | li  | prose  | visible | no   | 10.04 |    1285 |  1368 |  1368 | 1425 |
| li-3      | li  | prose  | visible | no   | 10.04 |    1285 |  1434 |  1434 | 1500 |
| comment-1 | p   | prose  | visible | no   | 10.05 |    1285 |  1498 |  1498 | 1575 |
| comment-2 | p   | prose  | visible | no   | 10.05 |    1355 |  1381 |  1381 | 1450 |
