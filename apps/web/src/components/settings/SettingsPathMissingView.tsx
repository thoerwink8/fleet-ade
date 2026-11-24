import { Link } from "@tanstack/react-router";

import { Button } from "../ui/button";

export function SettingsPathMissingView() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-dialog-title font-medium text-foreground">页面不存在</h1>
        <p className="text-sm text-muted-foreground">
          这个地址不是设置里的页面。返回设置首页继续。
        </p>
        <Button render={<Link to="/settings/general" replace />}>返回设置首页</Button>
      </div>
    </div>
  );
}
