/** C-161 新增界面文案：待定，由人确认。 */
export const employeeCopy = {
  tab: "员工",
  settingsDescription:
    "管理当前项目的偏好、授权、角色和卡片模板，以及全局员工。",
  heading: "新建员工",
  description:
    "员工是服务所有项目的团队成员。选择人物或自定义资料，再为员工指定一个角色。",
  afterRole: "为这个角色新建员工",
  loading: "正在加载人物库和角色…",
  source: "员工形象",
  library: "从人物库选择",
  custom: "自定义名字和头像",
  search: "搜索人物或出处",
  emptySearch: "没有找到匹配的人物。",
  name: "名字",
  title: "职位",
  role: "角色",
  chooseRole: "请选择角色",
  noRoles: "本项目还没有已启用的角色，请先在“角色”中创建或启用。",
  bio: "简介（可选）",
  avatar: "上传头像（可选）",
  uploadHint: "支持 PNG、JPG、WebP，最大 2 MiB。",
  uploadTooLarge: "头像图片不能超过 2 MiB。",
  uploadFailed: "无法读取头像文件，请重新选择。",
  reading: "正在读取头像…",
  choosePerson: "请选择一个未被占用的人物。",
  submit: "创建员工",
  submitting: "正在创建…",
  occupied: (name: string, id: string, inactive: boolean) =>
    `已由 ${name}（${id}${inactive ? "，已离职" : ""}）使用`,
  created: (name: string, id: string) => `已创建员工 ${name}（${id}）`,
} as const;
