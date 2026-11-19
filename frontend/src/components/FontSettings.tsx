import { useMemo, useRef, useState } from "react";
import { BODY_LIMITS, BUILTIN, DEFAULTS, cssFamily, useAppearance, type Kind, type Slot, type UploadFailure } from "../lib/appearance";
import { formatSize } from "../lib/labels";
import type { FontFile } from "../lib/types";
import { KindText } from "./KindText";
import { NumberBox } from "./SettingsView";
import { Button, ConfirmButton, Field, Row, Rows, Section, TextButton, Toggle, inputClass } from "./ui";

/*
 * 설정의 `폰트` 구획. 자리(시스템·제목·본문)마다 폰트를 고르고, 본문의 글자 크기·줄 간격·너비를 정하고,
 * 폰트 파일을 올려 더한다. `고급`을 펼치면 글의 종류(보통, 굵게, 기울임, 따옴표 안)마다 폰트와 색을 따로 정한다.
 * 고치면 바로 화면에 반영되고 잠깐 뒤에 저장된다 (lib/appearance.ts).
 */

const FONT_ACCEPT = ".ttf,.otf,.woff,.woff2";

/** 같은 이름의 파일들이 한 폰트다. */
interface Family {
  family: string;
  files: FontFile[];
}

const SLOTS: { slot: Slot; label: string; empty: string }[] = [
  { slot: "system", label: "시스템", empty: "기본 (Noto Sans KR)" },
  { slot: "title", label: "제목", empty: "기본" },
  { slot: "body", label: "본문", empty: "기본 (Noto Serif KR)" },
];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "normal", label: "보통" },
  { kind: "bold", label: "굵게" },
  { kind: "italic", label: "기울임" },
  { kind: "dquote", label: "큰따옴표" },
  { kind: "squote", label: "작은따옴표" },
];

/** 미리보기. 제목 줄과 다섯 종류가 다 들어 있다. */
const SAMPLE = `# 등탑

서윤은 계단 중간에서 걸음을 멈췄다. 등탑 위에서 누군가 **분명히** 웃고 있었다.

"아버지, 저 왔어요."

대답은 없었다. '또 못 들은 척이네.' 서윤은 난간을 *천천히* 쓸어 올렸다.`;

function weightText(f: FontFile): string {
  const weight = f.weight[0] === f.weight[1] ? String(f.weight[0]) : `${f.weight[0]}–${f.weight[1]}`;
  return f.italic ? `${weight} 기울임` : weight;
}

/** 폰트 하나를 고른다. 값은 폰트 이름이고, 따로 정하지 않은 것은 null이다. */
function FontSelect({
  value,
  onChange,
  empty,
  choices,
  label,
  className = "",
}: {
  value: string | null;
  onChange: (family: string | null) => void;
  empty: string; // 따로 정하지 않았을 때 보이는 말
  choices: { family: string; label: string }[];
  label?: string; // 화면 낭독기용 이름 (Field 안에 있으면 필요 없다)
  className?: string;
}) {
  // 지운 폰트를 가리키는 설정은 그대로 두고, 없다는 것만 보인다 (다시 올리면 되살아난다).
  const missing = value !== null && !choices.some((c) => c.family === value);
  return (
    <select className={`${inputClass} ${className}`} value={value ?? ""} aria-label={label} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty}</option>
      {choices.map((c) => (
        <option key={c.family} value={c.family}>
          {c.label}
        </option>
      ))}
      {missing && <option value={value}>{value} (없음)</option>}
    </select>
  );
}

export function FontSettings() {
  const value = useAppearance((s) => s.value);
  const fonts = useAppearance((s) => s.fonts);
  const setFont = useAppearance((s) => s.setFont);
  const setBody = useAppearance((s) => s.setBody);
  const reset = useAppearance((s) => s.reset);
  const upload = useAppearance((s) => s.upload);
  const removeFamily = useAppearance((s) => s.removeFamily);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<UploadFailure[]>([]);
  const picker = useRef<HTMLInputElement>(null);

  const families = useMemo(() => {
    const byName = new Map<string, Family>();
    for (const f of fonts) {
      const entry = byName.get(f.family) ?? { family: f.family, files: [] };
      entry.files.push(f);
      byName.set(f.family, entry);
    }
    return [...byName.values()];
  }, [fonts]);

  const choices = useMemo(
    () => [
      ...BUILTIN.map((b) => ({ family: b.family, label: b.label })),
      ...families.filter((f) => !BUILTIN.some((b) => b.family === f.family)).map((f) => ({ family: f.family, label: f.family })),
    ],
    [families],
  );

  // 값이 기본값과 같으면 되돌릴 것이 없다 (두 쪽 다 같은 순서로 만든 객체라 글로 견줘도 된다).
  const untouched = useMemo(() => JSON.stringify(value) === JSON.stringify(DEFAULTS), [value]);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setFailed([]);
    setFailed(await upload(files));
    setBusy(false);
  };

  return (
    <Section
      title="폰트"
      className="basis-full"
      right={<ConfirmButton label="기본값으로" confirm="되돌리기 확인" disabled={untouched} onConfirm={reset} />}
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-6 gap-y-4">
        {SLOTS.map(({ slot, label, empty }) => (
          <Field key={slot} label={label}>
            <FontSelect value={value.fonts[slot]} empty={empty} choices={choices} onChange={(family) => setFont(slot, family)} />
          </Field>
        ))}
        <Field label="글자 크기 (px)">
          <NumberBox lazy required decimal min={BODY_LIMITS.size[0]} max={BODY_LIMITS.size[1]} value={value.body.size} onChange={(v) => v !== null && setBody({ size: v })} />
        </Field>
        <Field label="줄 간격">
          <NumberBox
            lazy
            required
            decimal
            min={BODY_LIMITS.line_height[0]}
            max={BODY_LIMITS.line_height[1]}
            value={value.body.line_height}
            onChange={(v) => v !== null && setBody({ line_height: v })}
          />
        </Field>
        <Field label="본문 너비 (px)">
          <NumberBox lazy required min={BODY_LIMITS.width[0]} max={BODY_LIMITS.width[1]} value={value.body.width} onChange={(v) => v !== null && setBody({ width: v })} />
        </Field>
      </div>

      {families.length > 0 && (
        <Rows className="text-[13px]">
          {families.map((f) => (
            <Row key={f.family} className="!min-h-11">
              {/* 이름을 그 폰트로 쓴다. 어떻게 생긴 폰트인지 바로 보인다. */}
              <span className="min-w-0 truncate text-base" style={{ fontFamily: cssFamily(f.family) }}>
                {f.family}
              </span>
              <span className="flex-1" />
              <span className="min-w-0 truncate text-muted">{f.files.map(weightText).join(" · ")}</span>
              <span className="shrink-0 text-muted tabular-nums">{formatSize(f.files.reduce((n, x) => n + x.size, 0))}</span>
              <ConfirmButton label="삭제" confirm="삭제 확인" onConfirm={() => void removeFamily(f.family)} />
            </Row>
          ))}
        </Rows>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button small disabled={busy} onClick={() => picker.current?.click()}>
          폰트 추가
        </Button>
        <input
          ref={picker}
          type="file"
          accept={FONT_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void add(files);
          }}
        />
        <TextButton aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          고급
        </TextButton>
      </div>
      {/* 거절된 파일은 서버가 준 이유를 그대로 보인다. */}
      {failed.map((f) => (
        <div key={f.name} className="text-[13px] text-danger">
          {f.name}: {f.error}
        </div>
      ))}

      {advanced && (
        <div className="flex flex-wrap items-start gap-x-10 gap-y-6 border-t border-hair pt-2">
          <Rows className="flex-[1_1_440px] text-[13px]">
            {KINDS.map(({ kind, label }) => (
              <KindRow key={kind} kind={kind} label={label} choices={choices} />
            ))}
          </Rows>
          <div className="manuscript tk-text min-w-0 flex-[1_1_360px] pt-2">
            <KindText text={SAMPLE} />
          </div>
        </div>
      )}
    </Section>
  );
}

function KindRow({ kind, label, choices }: { kind: Kind; label: string; choices: { family: string; label: string }[] }) {
  const style = useAppearance((s) => s.value.kinds[kind]);
  const heavy = useAppearance((s) => s.value.kinds.bold.heavy);
  const slant = useAppearance((s) => s.value.kinds.italic.slant);
  const setKind = useAppearance((s) => s.setKind);
  return (
    <Row className="!min-h-12 flex-wrap gap-y-1 py-1.5">
      <span className="w-20 shrink-0 font-bold">{label}</span>
      <FontSelect
        className="!h-8 flex-[1_1_150px] !text-[13px]"
        label={`${label} 폰트`}
        value={style.font}
        empty="본문과 같음"
        choices={choices}
        onChange={(font) => setKind(kind, { font })}
      />
      {/* 색을 정하지 않았으면 본문의 글자색이 칸에 보인다. */}
      <input
        type="color"
        aria-label={`${label} 색`}
        title="색"
        className="h-8 w-10 shrink-0 cursor-pointer rounded-lg border border-line bg-bg p-1"
        value={style.color ?? "#1a1a2e"}
        onChange={(e) => setKind(kind, { color: e.target.value })}
      />
      {/* 색을 정했을 때만 보인다. 자리는 늘 차지해서 줄들이 가지런하다. */}
      <TextButton className={style.color ? "shrink-0" : "invisible shrink-0"} disabled={!style.color} aria-label={`${label} 색을 본문과 같게`} onClick={() => setKind(kind, { color: null })}>
        본문과 같음
      </TextButton>
      <span className="flex w-[88px] shrink-0 justify-end">
        {kind === "bold" && <Switch label="두껍게" checked={heavy} onChange={(v) => setKind("bold", { heavy: v })} />}
        {kind === "italic" && <Switch label="눕히기" checked={slant} onChange={(v) => setKind("italic", { slant: v })} />}
      </span>
    </Row>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <Toggle label={label} checked={checked} onChange={onChange} />
      {label}
    </span>
  );
}
