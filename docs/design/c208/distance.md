# C-204 暗色色差

sRGB、D65、CIEDE2000，kL=kC=kH=1。以 C/W/Q/A/R/D/V/H/E 九类为最近邻集合；M/MB/unknown 允许共用 E 的中性族。三组 Sharma 标准参考对误差小于 0.0001。

| 类型 | 最近文字邻色 / ΔE00 | 最近底色邻色 / ΔE00 | 最近状态色 / ΔE00 | 文字 L* |
|---|---|---|---|---|
| card | employee / 17.39 | employee / 7.59 | --status-pending / 10.92 | 62.38 |
| work-item | decision / 11.32 | decision / 7.55 | --status-review / 12.32 | 63.02 |
| decision | work-item / 11.32 | work-item / 7.55 | --status-review / 19.25 | 61.93 |
| assignment | review / 14.45 | human-action / 7.30 | --status-muted / 10.75 | 82.05 |
| run | assignment / 23.06 | assignment / 12.09 | --status-progress / 12.02 | 66.03 |
| delivery | review / 15.46 | review / 6.79 | --status-wait / 17.28 | 80.69 |
| review | assignment / 14.45 | delivery / 6.79 | --status-wait / 11.40 | 80.03 |
| human-action | employee / 10.67 | assignment / 7.30 | --status-muted / 12.45 | 61.80 |
| employee | human-action / 10.67 | card / 7.59 | --status-muted / 11.48 | 65.50 |
| member | employee / 0.00 | employee / 0.00 | --status-muted / 11.48 | 65.50 |
| merge-batch | employee / 0.00 | employee / 0.00 | --status-muted / 11.48 | 65.50 |
| unknown | employee / 0.00 | employee / 0.00 | --status-muted / 11.48 | 65.50 |

九类全部 36 对：

| 类型对 | 文字 ΔE00 | 底色 ΔE00 |
|---|---|---|
| card / work-item | 18.76 | 13.97 |
| card / decision | 29.70 | 17.57 |
| card / assignment | 24.35 | 12.08 |
| card / run | 24.55 | 16.83 |
| card / delivery | 56.65 | 28.47 |
| card / review | 38.21 | 23.82 |
| card / human-action | 24.29 | 14.54 |
| card / employee | 17.39 | 7.59 |
| work-item / decision | 11.32 | 7.55 |
| work-item / assignment | 28.84 | 20.22 |
| work-item / run | 33.50 | 25.77 |
| work-item / delivery | 66.90 | 37.82 |
| work-item / review | 45.20 | 31.19 |
| work-item / human-action | 23.63 | 17.53 |
| work-item / employee | 17.04 | 12.06 |
| decision / assignment | 29.69 | 17.72 |
| decision / run | 38.56 | 29.68 |
| decision / delivery | 66.34 | 33.37 |
| decision / review | 43.99 | 26.28 |
| decision / human-action | 21.12 | 13.14 |
| decision / employee | 19.08 | 11.39 |
| assignment / run | 23.06 | 12.09 |
| assignment / delivery | 25.78 | 14.02 |
| assignment / review | 14.45 | 11.02 |
| assignment / human-action | 19.18 | 7.30 |
| assignment / employee | 16.72 | 9.48 |
| run / delivery | 32.58 | 16.60 |
| run / review | 27.45 | 18.09 |
| run / human-action | 35.69 | 21.18 |
| run / employee | 30.99 | 19.19 |
| delivery / review | 15.46 | 6.79 |
| delivery / human-action | 35.58 | 19.19 |
| delivery / employee | 42.69 | 25.71 |
| review / human-action | 23.26 | 13.18 |
| review / employee | 28.25 | 20.20 |
| human-action / employee | 10.67 | 9.28 |
