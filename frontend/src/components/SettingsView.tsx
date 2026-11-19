import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { ModelEntry, Provider, ProviderKind } from "../lib/types";
import { useStore } from "../store";
import { FontSettings } from "./FontSettings";
import { Button, ConfirmButton, Field, Rows, Row, Section, Tag, TextButton, boxClass, inputClass } from "./ui";

/*
 * 설정의 내용(SettingsBody)과, 다른 화면도 같이 쓰는 입력 부품(ModelPicker, ModelField, NumberBox).
 * 겉틀은 여기 없다. 설정은 팝업(dialogs/SettingsDialog)에 담겨 뜬다.
 */

const UNTESTED = "실제 작동 테스트 안 됨";
/** 모델 고르기 목록에서 '직접 입력'을 뜻하는 값. 모델 이름과 겹치지 않는다. */
const TYPE_IT = "::직접 입력";

/** '제공자:모델' 참조를 고른다. 목록에서 골라도 되고 이름을 직접 적어도 된다. */
export function ModelPicker({
  value,
  onChange,
  emptyLabel,
  label = "모델",
}: {
  value: string;
  onChange: (ref: string) => void;
  emptyLabel?: string; // 주어지면 '지정 안 함'을 고를 수 있다
  label?: string; // 화면 낭독기용 이름
}) {
  const providers = useStore((s) => s.providers);
  const split = value.indexOf(":");
  const providerId = split === -1 ? "" : value.slice(0, split);
  const modelName = split === -1 ? "" : value.slice(split + 1);
  const [name, setName] = useState(modelName);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [typing, setTyping] = useState(false);
  const turn = useRef(0); // 늦게 온 응답이 다른 제공자의 목록을 덮지 않게 한다

  useEffect(() => setName(modelName), [modelName]);

  const load = (id: string, refresh = false) => {
    const mine = ++turn.current;
    if (!id) {
      setModels([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .models(id, refresh)
      .then((r) => {
        if (mine !== turn.current) return;
        setModels(r.models);
        setError(r.error);
      })
      .catch((e) => mine === turn.current && setError(String(e.message ?? e)))
      .finally(() => mine === turn.current && setLoading(false));
  };
  const usable = providers.filter((p) => p.enabled);
  const picked = providers.find((p) => p.id === providerId);
  /*
   * 고른 제공자에 키(로컬 제공자는 주소)가 아직 없다. 모델 목록을 받을 수 없으니 그 자리에 키를 넣으러 가는 버튼을 둔다.
   * 누르면 설정이 그 제공자를 펼친 채로 열리고, 키를 넣고 닫으면 여기서 목록이 받아진다 (ready가 바뀌면 다시 받는다).
   */
  const needsSetup = Boolean(picked && picked.enabled && !picked.ready);
  const ready = picked?.ready ?? false;
  const kinds = useStore((s) => s.meta?.provider_kinds);
  const openDialog = useStore((s) => s.openDialog);
  const setupLabel = kinds?.find((k) => k.id === picked?.kind)?.needs_key === false ? "주소 넣기" : "키 넣기";

  useEffect(() => {
    setModels([]);
    setError(null);
    setTyping(false);
    load(needsSetup ? "" : providerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, ready]);

  const info = models.find((m) => m.id === name);
  const listed = info !== undefined;
  // 목록이 없으면(제공자 없음, 받기 실패) 이름을 적는 칸으로 바뀐다
  const asText = typing || (!loading && models.length === 0);
  const unlisted = providerId !== "" && name !== "" && !loading && models.length > 0 && !listed;

  // 적혀 있는 제공자가 등록돼 있지 않거나(받아 온 프리셋) 꺼져 있으면 고르기 목록에 없다. 그 이름을 그대로 보이면서 쓸 수 없다고 알린다.
  const missing = providerId !== "" && !usable.some((p) => p.id === providerId);

  const notes: ReactNode[] = [];
  if (missing) notes.push(<span key="missing" className="text-danger">{picked ? "꺼져 있는 제공자" : "등록되지 않은 제공자"}</span>);
  if (picked && !picked.tested) notes.push(<Tag key="untested" tone="warn">{UNTESTED}</Tag>);
  if (info?.context) notes.push(<span key="context">맥락 {info.context.toLocaleString()} 토큰</span>);
  if (info?.price_in !== undefined)
    notes.push(
      <span key="price">
        100만 토큰당 ${info.price_in} / ${info.price_out}
      </span>,
    );
  // 등록되지 않은 제공자는 목록을 받지 못하는 것이 당연하다. 같은 말을 두 번 하지 않는다.
  if (error && !missing) notes.push(<span key="error" className="text-danger">{error}</span>);
  if (unlisted) notes.push(<span key="unlisted">목록에 없는 이름</span>);

  return (
    <div className="min-w-0">
      {/* 좁은 패널에서는 칸들이 줄을 바꿔 내려간다 */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={`${inputClass} flex-[1_1_120px]`}
          value={providerId}
          aria-label={`${label}의 제공자`}
          onChange={(e) => {
            setName("");
            onChange(e.target.value ? `${e.target.value}:` : "");
          }}
        >
          <option value="">{emptyLabel ?? "제공자 고르기"}</option>
          {missing && <option value={providerId}>{picked?.label ?? providerId}</option>}
          {usable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.ready ? "" : " (키 필요)"}
            </option>
          ))}
        </select>
        {needsSetup && name === "" ? null : asText ? (
          <input
            className={`${inputClass} flex-[2_1_200px]`}
            value={name}
            disabled={!providerId}
            autoFocus={typing}
            spellCheck={false}
            aria-label={label}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => providerId && name.trim() !== modelName && onChange(`${providerId}:${name.trim()}`)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <select
            className={`${inputClass} flex-[2_1_200px]`}
            value={name}
            disabled={loading}
            aria-label={label}
            onChange={(e) => {
              const next = e.target.value;
              if (next === TYPE_IT) {
                setTyping(true);
                return;
              }
              setName(next);
              onChange(`${providerId}:${next}`);
            }}
          >
            {name === "" && <option value="">{loading ? "목록 받는 중" : "모델 고르기"}</option>}
            {name !== "" && !listed && <option value={name}>{name}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label !== m.id ? `${m.label} (${m.id})` : m.id}
              </option>
            ))}
            <option value={TYPE_IT}>직접 입력</option>
          </select>
        )}
        {needsSetup ? (
          <Button small variant="primary" onClick={() => openDialog({ type: "settings", provider: providerId })}>
            {setupLabel}
          </Button>
        ) : (
          <Button small variant="quiet" className="enabled:!text-ink" onClick={() => load(providerId, true)} disabled={!providerId || loading}>
            목록 새로 받기
          </Button>
        )}
        {typing && models.length > 0 && <TextButton onClick={() => setTyping(false)}>목록에서 고르기</TextButton>}
      </div>
      {notes.length > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">{notes}</div>}
    </div>
  );
}

/** 이름표 아래에 고르기 칸이 여럿 놓이는 줄. (칸이 여럿이라 label로 감싸지 않는다) */
export function ModelField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

/** 소수는 `1.0`처럼 소수점을 붙여 보인다 (온도). */
function showDecimal(v: number): string {
  const text = String(Math.round(v * 100) / 100);
  return text.includes(".") ? text : `${text}.0`;
}

/**
 * 숫자 한 칸. 비울 수 있는 값이면 빈 칸이 null이다.
 * 기본은 칠 때마다 알린다 (프리셋·도구처럼 받는 쪽이 모아서 저장하는 값).
 * lazy면 칸을 떠날 때만 알린다 (알릴 때마다 서버에 가는 값).
 */
export function NumberBox({
  value,
  onChange,
  decimal = false,
  min = 0,
  max,
  required = false,
  lazy = false,
  placeholder,
  label,
  className = "",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  decimal?: boolean; // 소수 둘째 자리까지
  min?: number;
  max?: number;
  required?: boolean; // 비울 수 없다. 비우고 떠나면 원래 값으로 돌아온다
  lazy?: boolean;
  placeholder?: string;
  label?: string; // 화면 낭독기용 이름 (Field 안에 있으면 필요 없다)
  className?: string;
}) {
  const show = (v: number | null) => (v === null ? "" : decimal ? showDecimal(v) : String(v));
  /** 받아들일 수 없는 글이면 undefined. 범위를 벗어난 수는 범위 안으로 당긴다. */
  const parse = (text: string): number | null | undefined => {
    if (text === "") return required ? undefined : null;
    const typed = Number(text);
    if (!Number.isFinite(typed)) return undefined;
    const clamped = Math.min(max ?? Infinity, Math.max(min, typed));
    return decimal ? Math.round(clamped * 100) / 100 : Math.round(clamped);
  };
  const [text, setText] = useState(show(value));
  // 밖에서 값이 바뀌었을 때만 칸을 다시 채운다. 치고 있는 글자("0.")를 같은 값(0)으로 덮지 않는다.
  useEffect(() => {
    setText((cur) => (parse(cur) === value ? cur : show(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      className={`${inputClass} ${className}`}
      inputMode={decimal ? "decimal" : "numeric"}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => {
        const next = e.target.value.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, "");
        setText(next);
        if (lazy) return;
        const parsed = parse(next);
        if (parsed !== undefined && parsed !== value) onChange(parsed);
      }}
      onBlur={() => {
        const parsed = parse(text);
        if (parsed === undefined) {
          setText(show(value));
          return;
        }
        setText(show(parsed));
        if (parsed !== value) onChange(parsed);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

/**
 * 설정의 내용: 제공자와 폰트. 모델 설정은 여기 없고 프리셋(에이전트 패널)에 있다. 고치면 바로 저장된다.
 * provider: 펼친 채로 열 제공자 (모델 고르기의 `키 넣기`에서 왔을 때).
 */
export function SettingsBody({ provider }: { provider?: string }) {
  const providers = useStore((s) => s.providers);
  const kinds = useStore((s) => s.meta?.provider_kinds) ?? [];

  return (
    <div className="flex flex-wrap gap-x-12 gap-y-8">
      {/* 키는 저장한 뒤 화면에 다시 나오지 않는다. 그 말은 제목에 마우스를 올리면 뜬다. */}
      <Section className="flex-[1.3_1_480px]" title={<span title="키는 이 컴퓨터에만 저장되고 화면에 다시 나오지 않습니다">제공자</span>}>
        <Rows className="-mt-3 text-[13px]">
          {providers.map((p) => {
            const kind = kinds.find((k) => k.id === p.kind);
            return kind ? <ProviderRow key={p.id} provider={p} kind={kind} focus={p.id === provider} /> : null;
          })}
          <AddProvider kinds={kinds} existing={providers} />
        </Rows>
      </Section>

      <FontSettings />
    </div>
  );
}

function ProviderRow({ provider, kind, focus = false }: { provider: Provider; kind: ProviderKind; focus?: boolean }) {
  const refresh = useStore((s) => s.refreshProviders);
  const fail = useStore((s) => s.fail);
  const notify = useStore((s) => s.notify);
  // focus: 이 제공자의 키를 넣으러 온 것이다. 펼친 채로 열고 그 줄이 보이게 한다 (목록이 길어 창 아래에 있을 수 있다).
  const [open, setOpen] = useState(focus);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) root.current?.scrollIntoView({ block: "center" });
  }, [focus]);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [extra, setExtra] = useState<Record<string, string>>(provider.extra);
  const [check, setCheck] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const body = () => ({ kind: provider.kind, label: provider.label, base_url: baseUrl, extra, enabled: provider.enabled });
  const secretNames = kind.extra.filter((f) => f.secret).map((f) => f.name);
  const storedSecret = secretNames.some((name) => provider.secrets?.[name]?.set);

  const save = async (patch: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      await api.saveProvider(provider.id, { ...body(), ...(key ? { api_key: key } : {}), ...patch });
      setKey("");
      // 붙여 넣은 비밀값은 저장한 뒤 화면에 남기지 않는다
      setExtra((cur) => Object.fromEntries(Object.entries(cur).filter(([name]) => !secretNames.includes(name))));
      await refresh();
      notify("저장됨");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setCheck({ text: "확인 중", bad: false });
    try {
      const r = await api.models(provider.id, true);
      setCheck(r.error ? { text: r.error, bad: true } : { text: `연결됨 · 모델 ${r.models.length}개`, bad: false });
    } catch (e) {
      setCheck({ text: String((e as Error).message), bad: true });
    }
  };

  // 키 내용은 서버가 내보내지 않는다. 있는지와 서버가 준 요약만 보여준다.
  const summary = secretNames.map((name) => provider.secrets?.[name]?.summary).find(Boolean) ?? "";
  const address = kind.base_url_editable ? provider.effective_base_url.replace(/^https?:\/\//, "") : "";
  const detail = summary || address;
  const hasKey = storedSecret || provider.has_key;
  const state = storedSecret
    ? "서비스 계정 키 있음"
    : provider.has_key
      ? provider.key_source === "env"
        ? ".env의 키"
        : "키 있음"
      : kind.base_url_editable && !provider.effective_base_url
        ? "주소 없음"
        : kind.needs_key
          ? kind.key_optional
            ? "키 없음 (선택)"
            : "키 없음"
          : address
            ? ""
            : "키 필요 없음";

  const head = (
    <>
      <span className={`min-w-0 truncate text-sm font-bold ${provider.enabled ? "" : "text-muted"}`}>{provider.label}</span>
      {!provider.tested && <Tag tone="warn">{UNTESTED}</Tag>}
      {!provider.enabled && <Tag>꺼짐</Tag>}
      <span className="flex-1" />
      {state && <span className={`shrink-0 ${hasKey ? "font-bold text-agent" : "text-muted"}`}>{state}</span>}
      {detail && (
        <span className="min-w-0 shrink-[100] truncate font-mono text-muted" title={detail}>
          {detail}
        </span>
      )}
      <TextButton className="shrink-0" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "닫기" : "열기"}
      </TextButton>
    </>
  );

  if (!open) return <Row className="!min-h-11">{head}</Row>;

  return (
    <div ref={root} className="flex flex-col gap-3 border-b border-hair bg-sunken pt-3 pb-4">
      <div className="flex items-center gap-3 px-3">{head}</div>
      <div className="flex flex-wrap items-end gap-3 px-3">
        {kind.needs_key && (
          <Field className="flex-[1_1_260px]" label={provider.has_key ? "새 키로 바꾸기" : kind.key_optional ? "API 키 (선택)" : "API 키"}>
            <input type="password" autoComplete="off" autoFocus={focus} className={inputClass} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        )}
        {kind.base_url_editable && (
          <Field className="flex-[1_1_260px]" label={kind.default_base_url ? `주소 (비우면 ${kind.default_base_url})` : "주소 (base URL)"}>
            <input className={inputClass} spellCheck={false} autoFocus={focus && !kind.needs_key} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
        )}
        {kind.extra.map((f) => {
          const set = (v: string) => setExtra((cur) => ({ ...cur, [f.name]: v }));
          const value = extra[f.name] ?? "";
          if (f.secret) return <SecretField key={f.name} label={f.label} multiline={f.multiline} stored={provider.secrets?.[f.name]} value={value} onChange={set} />;
          return f.multiline ? (
            <Field key={f.name} className="basis-full" label={f.label}>
              <textarea className={boxClass} rows={3} value={value} onChange={(e) => set(e.target.value)} />
            </Field>
          ) : (
            <Field key={f.name} className="flex-[1_1_260px]" label={f.label}>
              <input className={inputClass} value={value} onChange={(e) => set(e.target.value)} />
            </Field>
          );
        })}
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          저장
        </Button>
        {((provider.has_key && provider.key_source === "config") || storedSecret) && (
          <Button
            variant="quiet"
            onClick={() =>
              void api
                .clearProviderKey(provider.id)
                .then(refresh)
                .then(() => notify("저장된 키 삭제됨"))
                .catch(fail)
            }
          >
            키 지우기
          </Button>
        )}
        {kind.key_url && (
          <a className="link pb-[7px] text-[13px]" href={kind.key_url} target="_blank" rel="noreferrer">
            키 받는 곳
          </a>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3">
        <TextButton onClick={() => void test()}>연결 확인</TextButton>
        <TextButton onClick={() => void save({ enabled: !provider.enabled })} disabled={busy}>
          {provider.enabled ? "끄기" : "켜기"}
        </TextButton>
        {check && <span className={`min-w-0 text-xs ${check.bad ? "text-danger" : "text-agent"}`}>{check.text}</span>}
        <span className="flex-1" />
        <ConfirmButton label="목록에서 지우기" confirm="지우기 확인" onConfirm={() => void api.deleteProvider(provider.id).then(refresh).catch(fail)} />
      </div>
    </div>
  );
}

/** 비밀값 입력. 저장된 값은 다시 보여주지 않는다. 키 파일처럼 긴 것은 붙여 넣거나 파일을 골라 넣는다. */
function SecretField({
  label,
  multiline,
  stored,
  value,
  onChange,
}: {
  label: string;
  multiline: boolean;
  stored?: { set: boolean; summary: string };
  value: string;
  onChange: (v: string) => void;
}) {
  const fail = useStore((s) => s.fail);
  const file = useRef<HTMLInputElement>(null);
  const saved = stored?.set ? "저장됨" : undefined;

  if (!multiline)
    return (
      <Field className="flex-[1_1_260px]" label={label} right={saved}>
        <input type="password" autoComplete="off" className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );

  return (
    <div className="flex basis-full flex-col items-start gap-1.5">
      <Field className="w-full" label={label} right={saved}>
        <textarea
          className={`${boxClass} font-mono !text-xs`}
          rows={value ? 6 : 2}
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      <Button small variant="quiet" onClick={() => file.current?.click()}>
        파일 선택
      </Button>
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (picked) void picked.text().then(onChange).catch(fail);
        }}
      />
    </div>
  );
}

function AddProvider({ kinds, existing }: { kinds: ProviderKind[]; existing: Provider[] }) {
  const refresh = useStore((s) => s.refreshProviders);
  const fail = useStore((s) => s.fail);
  const [open, setOpen] = useState(false);
  const [kindId, setKindId] = useState("openai_compatible");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const kind = kinds.find((k) => k.id === kindId);
  const taken = existing.some((p) => p.id === id.trim());
  const validId = /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id.trim());

  // 마지막 제공자 줄의 가는 밑줄을 검은 줄로 덮어 목록을 닫는다
  if (!open)
    return (
      <div className="-mt-px border-t border-ink py-2.5">
        <TextButton onClick={() => setOpen(true)}>+ 제공자 더하기</TextButton>
      </div>
    );
  return (
    <form
      className="-mt-px flex flex-col gap-3 border-t border-ink bg-sunken px-3 pt-3 pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!validId || taken) return;
        void api
          .saveProvider(id.trim(), { kind: kindId, label: label.trim(), base_url: baseUrl.trim() })
          .then(refresh)
          .then(() => {
            setOpen(false);
            setId("");
            setLabel("");
            setBaseUrl("");
          })
          .catch(fail);
      }}
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <Field label="종류">
          <select className={inputClass} value={kindId} onChange={(e) => setKindId(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="식별자 (영문 소문자·숫자·-·_)" right={taken ? <span className="text-danger">이미 있습니다</span> : undefined}>
          <input className={inputClass} spellCheck={false} value={id} onChange={(e) => setId(e.target.value)} />
        </Field>
        <Field label="표시 이름 (비우면 종류 이름)">
          <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {kind?.base_url_editable && (
          <Field label={kind.default_base_url ? `주소 (비우면 ${kind.default_base_url})` : "주소 (base URL)"}>
            <input className={inputClass} spellCheck={false} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="flex items-center gap-4">
        <Button variant="primary" type="submit" disabled={!validId || taken}>
          더하기
        </Button>
        <TextButton onClick={() => setOpen(false)}>취소</TextButton>
      </div>
    </form>
  );
}
