# C-204 暗色色差

sRGB、D65、CIEDE2000，kL=kC=kH=1。以 C/W/Q/A/R/D/V/H/E 九类为最近邻集合；M/MB/unknown 允许共用 E 的中性族。三组 Sharma 标准参考对误差小于 0.0001。

| 类型 | 最近文字邻色 / ΔE00 | 最近底色邻色 / ΔE00 | 最近状态色 / ΔE00 |
|---|---|---|---|
| card | employee / 17.39 | employee / 7.59 | --status-pending / 10.92 |
| work-item | decision / 11.32 | decision / 7.55 | --status-review / 12.32 |
| decision | work-item / 11.32 | work-item / 7.55 | --status-review / 19.25 |
| assignment | review / 15.31 | human-action / 7.30 | --status-muted / 11.55 |
| run | assignment / 16.44 | assignment / 12.09 | --status-progress / 11.80 |
| delivery | review / 15.56 | review / 6.79 | --status-wait / 17.64 |
| review | assignment / 15.31 | delivery / 6.79 | --status-wait / 11.55 |
| human-action | employee / 10.67 | assignment / 7.30 | --status-cancelled / 12.50 |
| employee | human-action / 10.67 | card / 7.59 | --status-idle / 11.84 |
| member | employee / 0.00 | employee / 0.00 | --status-idle / 11.84 |
| merge-batch | employee / 0.00 | employee / 0.00 | --status-idle / 11.84 |
| unknown | employee / 0.00 | employee / 0.00 | --status-idle / 11.84 |

九类全部 36 对：

| 类型对 | 文字 ΔE00 | 底色 ΔE00 |
|---|---|---|
| card / work-item | 18.76 | 13.97 |
| card / decision | 29.70 | 17.57 |
| card / assignment | 27.69 | 12.08 |
| card / run | 30.39 | 16.83 |
| card / delivery | 57.10 | 28.47 |
| card / review | 40.38 | 23.82 |
| card / human-action | 24.29 | 14.54 |
| card / employee | 17.39 | 7.59 |
| work-item / decision | 11.32 | 7.55 |
| work-item / assignment | 31.63 | 20.22 |
| work-item / run | 34.72 | 25.77 |
| work-item / delivery | 67.32 | 37.82 |
| work-item / review | 46.87 | 31.19 |
| work-item / human-action | 23.63 | 17.53 |
| work-item / employee | 17.04 | 12.06 |
| decision / assignment | 32.54 | 17.72 |
| decision / run | 38.28 | 29.68 |
| decision / delivery | 66.80 | 33.37 |
| decision / review | 45.65 | 26.28 |
| decision / human-action | 21.12 | 13.14 |
| decision / employee | 19.08 | 11.39 |
| assignment / run | 16.44 | 12.09 |
| assignment / delivery | 26.06 | 14.02 |
| assignment / review | 15.31 | 11.02 |
| assignment / human-action | 23.38 | 7.30 |
| assignment / employee | 20.70 | 9.48 |
| run / delivery | 31.36 | 16.60 |
| run / review | 25.30 | 18.09 |
| run / human-action | 38.63 | 21.18 |
| run / employee | 33.10 | 19.19 |
| delivery / review | 15.56 | 6.79 |
| delivery / human-action | 36.40 | 19.19 |
| delivery / employee | 43.23 | 25.71 |
| review / human-action | 25.92 | 13.18 |
| review / employee | 30.41 | 20.20 |
| human-action / employee | 10.67 | 9.28 |
