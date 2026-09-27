import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, Download04Icon, Upload04Icon } from "@hugeicons/core-free-icons"
import { useMutation } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"
import type { BackupFile } from "@shared/types"
import { SettingRow, SettingRows } from "@/components/settings-layout"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { fmtAgo } from "@/lib/format"

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function readBackup(file: File): Promise<BackupFile> {
  return file.text().then((text) => {
    let b: BackupFile
    try {
      b = JSON.parse(text)
    } catch {
      throw new Error("That file isn't JSON")
    }
    if (b?.app !== "dubplate" || b.format !== 1) throw new Error("That isn't a Dubplate backup")
    return b
  })
}

export function BackupSettings({ onRestored }: { onRestored: () => void }) {
  const [secrets, setSecrets] = useState(false)
  const [backup, setBackup] = useState<BackupFile | null>(null)
  const [parts, setParts] = useState({ settings: true, learnings: true, libraries: true })
  const input = useRef<HTMLInputElement>(null)
  const restore = useMutation({
    mutationFn: () => api.restore(backup!, parts),
    onSuccess: (r) => {
      const bits = [
        r.settings && "settings",
        r.aliases && plural(r.aliases, "alias", "aliases"),
        r.corrections && plural(r.corrections, "new correction"),
        (r.libraries.added || r.libraries.updated) && `${plural(r.libraries.added + r.libraries.updated, "library", "libraries")}`,
      ].filter(Boolean)
      toast.success(`Restored ${bits.join(", ") || "nothing new"}`, {
        description: r.libraries.skipped.length ? `Skipped: ${r.libraries.skipped.map((s) => `${s.path} (${s.reason})`).join("; ")}` : undefined,
        duration: 8000,
      })
      setBackup(null)
      if (input.current) input.current.value = ""
      onRestored()
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Back up</CardTitle>
          <CardDescription>One file with your settings, what Dubplate has learned (aliases and corrections) and your libraries. Handy before moving to a new machine.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRows>
            <SettingRow title="Include API keys and tokens" description="Off: keys are left out and stay on this machine. On: keep the file somewhere safe.">
              <Switch checked={secrets} onCheckedChange={setSecrets} aria-label="Include API keys and tokens" />
            </SettingRow>
            <SettingRow title="Download a backup" description={secrets ? "Includes keys and tokens." : "No keys or tokens."}>
              <Button nativeButton={false} render={<a href={api.backupUrl(secrets)} download />} variant="outline">
                <HugeiconsIcon icon={Download04Icon} strokeWidth={2} data-icon="inline-start" />
                Download
              </Button>
            </SettingRow>
          </SettingRows>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Restore</CardTitle>
          <CardDescription>Settings are replaced; aliases, corrections and libraries are added to what's here. Keys the backup doesn't have are kept.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file)
                readBackup(file)
                  .then(setBackup)
                  .catch((err: Error) => {
                    toast.error(err.message)
                    e.target.value = ""
                  })
            }}
          />
          <Button variant="outline" onClick={() => input.current?.click()}>
            <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} data-icon="inline-start" />
            Choose a backup file
          </Button>
          {backup && (
            <div className="animate-in fade-in slide-in-from-top-1 space-y-3 rounded-2xl border p-4 duration-200">
              <div className="text-sm">
                Backup from <span className="font-medium">{fmtAgo(backup.exportedAt)}</span> (Dubplate {backup.version}){backup.secrets ? ", with keys and tokens" : ""}.
              </div>
              {(
                [
                  ["settings", "Settings", "every setting, replacing the current ones"],
                  ["learnings", "What it's learned", `${plural(backup.aliases.length, "alias", "aliases")} and ${plural(backup.corrections.length, "correction")}`],
                  ["libraries", "Libraries", backup.libraries.map((l) => l.name).join(", ") || "none"],
                ] as const
              ).map(([key, label, detail]) => (
                <label key={key} className="flex items-start gap-3 text-sm">
                  <Checkbox checked={parts[key]} onCheckedChange={(v) => setParts((p) => ({ ...p, [key]: !!v }))} className="mt-0.5" />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="text-muted-foreground block text-xs">{detail}</span>
                  </span>
                </label>
              ))}
              {parts.settings && (
                <p className="text-rasta-gold flex items-center gap-1.5 text-xs">
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5" />
                  Unsaved changes on this page are discarded.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setBackup(null)}>
                  Cancel
                </Button>
                <Button onClick={() => restore.mutate()} disabled={restore.isPending || (!parts.settings && !parts.learnings && !parts.libraries)}>
                  {restore.isPending && <Spinner data-icon="inline-start" />}
                  Restore
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  )
}
