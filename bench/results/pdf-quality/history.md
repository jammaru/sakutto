| label | pages | untranslated prose | mixed language | garbled tokens | overlap/box | overflow/box | reading order | first block ms | full ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 5 | 13.0% | 20.9% | 0.84% | 0.000 | 0.062 | 98.3% | 307 | 909 |
| final | 5 | 0.0% | 10.8% | 0.31% | 0.000 | 0.046 | 98.3% | 248 | 840 |

iter1 / iter2 runs are kept as separate JSON/MD files; the garbledToken metric was refined once
after iter2 to also count a whole English clause left inside a translated block, and baseline and
final above use that final definition.
