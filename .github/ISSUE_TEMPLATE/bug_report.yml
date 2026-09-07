name: 🐛 Bug 反馈
description: 创建一个报告来帮助我们改进
title: "[Bug] "
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        感谢您花时间填写此 Bug 报告！请尽可能详细地提供以下信息，以便我们更快地定位问题。

  - type: textarea
    id: bug-description
    attributes:
      label: 描述 Bug
      description: 请清晰简洁地描述这个 Bug 是什么。
      placeholder: 例如：点击登录按钮后页面无响应...
    validations:
      required: true

  - type: textarea
    id: reproduction-steps
    attributes:
      label: 复现步骤
      description: 请描述如何复现这个问题。
      placeholder: |
        1. 执行 '...'
        2. 点击 '....'
        3. 出现报错 '....'
    validations:
      required: true

  - type: textarea
    id: expected-behavior
    attributes:
      label: 预期行为
      description: 请清晰简洁地描述你期望发生什么。
      placeholder: 例如：点击登录后应跳转到首页...
    validations:
      required: true

  - type: textarea
    id: screenshots
    attributes:
      label: 截图
      description: 如果可以，请添加截图以帮助解释您的问题。
      placeholder: 拖拽图片到此处或粘贴截图链接...
    validations:
      required: false

  - type: dropdown
    id: os
    attributes:
      label: 操作系统
      description: 请选择您使用的操作系统。
      options:
        - Windows
        - macOS
        - Linux
        - Other
    validations:
      required: true

  - type: input
    id: node-version
    attributes:
      label: Node.js 版本
      description: 请输入您的 Node.js 版本号。
      placeholder: 例如 v18.16.0
    validations:
      required: true

  - type: input
    id: project-version
    attributes:
      label: 项目版本
      description: 请输入您当前使用的项目版本。
      placeholder: 例如 v1.0.0
    validations:
      required: true

  - type: textarea
    id: additional-context
    attributes:
      label: 其他信息
      description: 在此添加关于该问题的任何其他背景信息。
      placeholder: 例如：相关的日志输出、配置文件片段等...
    validations:
      required: false
