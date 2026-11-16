import { useState } from 'react'
import { Monitor, Moon, RotateCcw, ShieldAlert, Sun } from 'lucide-react'
import PageHeader from '@/components/PageHeader'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { languageOptions, useI18n, type TranslationKey } from '@/i18n'
import type { AppSettings, Language, ThemeSetting } from '@/types'

type SettingsProps = {
  settings: AppSettings
  onChangeSettings: (settings: AppSettings) => void
  onResetAll: () => void
}

const themeOptions: {
  id: ThemeSetting
  labelKey: TranslationKey
  Icon: typeof Moon
}[] = [
  { id: 'dark', labelKey: 'settings.themeDark', Icon: Moon },
  { id: 'light', labelKey: 'settings.themeLight', Icon: Sun },
  { id: 'system', labelKey: 'settings.themeAuto', Icon: Monitor },
]

function Settings({ settings, onChangeSettings, onResetAll }: SettingsProps) {
  const { t } = useI18n()
  const [resetOpen, setResetOpen] = useState(false)

  function handleThemeChange(theme: ThemeSetting) {
    onChangeSettings({ ...settings, theme })
  }

  function handleLanguageChange(language: Language) {
    onChangeSettings({ ...settings, language })
  }

  function handleConfirmReset() {
    onResetAll()
    setResetOpen(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('settings.title')} />

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.title')}</CardTitle>
          <CardDescription>{t('settings.themeDesc')}</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col divide-y divide-border p-0">
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
            <div className="flex flex-col gap-0.5">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.language')}
              </strong>
              <span className="text-[11.5px] text-muted-foreground">
                {t('settings.languageDesc')}
              </span>
            </div>

            <Tabs
              value={settings.language}
              onValueChange={(val) => handleLanguageChange(val as Language)}
            >
              <TabsList aria-label={t('settings.language')}>
                {languageOptions.map((option) => (
                  <TabsTrigger key={option.id} value={option.id}>
                    {option.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
            <div className="flex flex-col gap-0.5">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.theme')}
              </strong>
              <span className="text-[11.5px] text-muted-foreground">
                {t('settings.themeDesc')}
              </span>
            </div>

            <Tabs
              value={settings.theme}
              onValueChange={(val) => handleThemeChange(val as ThemeSetting)}
            >
              <TabsList aria-label={t('settings.theme')}>
                {themeOptions.map(({ id, labelKey, Icon }) => (
                  <TabsTrigger key={id} value={id}>
                    <Icon className="size-3.5" />
                    <span>{t(labelKey)}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
            <div className="flex flex-col gap-0.5">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.tradingSetup')}
              </strong>
              <span className="text-[11.5px] text-muted-foreground">
                {t('settings.tradingSetupDesc')}
              </span>
            </div>

            <Badge variant="default">{t('settings.simulation')}</Badge>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
            <div className="flex max-w-xl flex-col gap-0.5">
              <strong className="text-xs font-semibold text-foreground">
                {t('settings.storedData')}
              </strong>
              <span className="text-[11.5px] text-muted-foreground">
                {t('settings.storedDataDesc')}
              </span>
            </div>

            <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="destructive" size="sm">
                  <RotateCcw className="size-3.5" />
                  <span>{t('settings.reset')}</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <ShieldAlert className="size-4 text-[var(--negative)]" />
                    <span>{t('settings.reset')}</span>
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('settings.resetConfirm')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('settings.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleConfirmReset}>
                    {t('settings.resetYes')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default Settings
