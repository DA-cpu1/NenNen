/**
 * 工具操作防重的自动检查（05 §5）：固定请求重复执行不重复写、
 * 已成功直接返回旧结果、失败可重跑且只许落定一次。
 * 固定输入、临时假库（07 §3）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import {
  beginToolOperation,
  buildOperationKey,
  completeToolOperation,
  failToolOperation,
} from '../src/data/tool-ops'
import { messages, toolOperations } from '../src/data/tables'

let dir: string
let companion: CompanionDb
/** 会话与消息 ID：操作要挂在真实会话/消息上（外键要求存在） */
let conversationId: string
let messageId: string

const now = 1740000006000

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'companion-toolops-test-'))
  companion = openCompanionDatabase(join(dir, 'test.db'))
  runMigrations(companion.sqlite)
  const initial = initializeFirstCharacter(companion.db, {
    name: '六花',
    personaText: '占位人设',
    initialRelationship: '恋人',
    timezone: 'Asia/Shanghai',
    now,
  })
  conversationId = initial.conversationId
  // 触发工具的那条用户消息（「记住我叫阿达」那句）
  companion.db
    .insert(messages)
    .values({
      id: 'msg-toolops-001',
      conversationId,
      seq: 1,
      role: 'user',
      content: '记住我喜欢蓝色',
      status: 'completed',
      clientRequestId: 'req-toolops-001',
      createdAt: now,
    })
    .run()
  messageId = 'msg-toolops-001'
})

afterAll(async () => {
  companion.close()
  await rm(dir, { recursive: true, force: true })
})

describe('操作编号拼接（T04 步骤⑦）', () => {
  it('同样输入拼出同一编号；换目标就是另一件事', () => {
    const base = buildOperationKey({
      conversationId,
      requestMessageId: messageId,
      toolName: 'remember_explicit',
    })
    // 完全相同的输入 → 同一编号（重试才能被认出来）
    expect(
      buildOperationKey({
        conversationId,
        requestMessageId: messageId,
        toolName: 'remember_explicit',
      }),
    ).toBe(base)
    // 目标不同 → 不同编号
    expect(
      buildOperationKey({
        conversationId,
        requestMessageId: messageId,
        toolName: 'correct_memory',
        targetId: 'mem-001',
      }),
    ).not.toBe(base)
  })
})

describe('登记、落定与防重（T04 步骤⑦）', () => {
  // 固定编号：全组用例共用，模拟「同一件事反复到达」
  const operationKey = buildOperationKey({
    conversationId,
    requestMessageId: messageId,
    toolName: 'remember_explicit',
  })

  it('首次登记：kind=new，pending 行带消息关联落库', () => {
    const begin = beginToolOperation(companion.db, {
      operationKey,
      conversationId,
      toolName: 'remember_explicit',
      requestMessageId: messageId,
      now,
    })
    expect(begin.kind).toBe('new')
    expect(begin.operationId).toMatch(/^op-/)

    const row = companion.db
      .select()
      .from(toolOperations)
      .where(eq(toolOperations.id, begin.operationId))
      .get()
    expect(row?.status).toBe('pending')
    // 回执挂到了触发它的那条消息上（05 §5「关联到原始用户消息」）
    expect(row?.requestMessageId).toBe(messageId)
  })

  it('执行中重复到达：kind=in-progress，不开第二份', () => {
    const again = beginToolOperation(companion.db, {
      operationKey,
      conversationId,
      toolName: 'remember_explicit',
      requestMessageId: messageId,
      now,
    })
    expect(again.kind).toBe('in-progress')
    expect(companion.db.select().from(toolOperations).all()).toHaveLength(1)
  })

  it('成功落定：committed 带结果 JSON', () => {
    // begin 返回的 operationId 在上面两个用例里是同一个，这里重新拿
    const begin = beginToolOperation(companion.db, {
      operationKey,
      conversationId,
      toolName: 'remember_explicit',
      requestMessageId: messageId,
      now,
    })
    expect(begin.kind).toBe('in-progress')
    if (begin.kind !== 'in-progress') return
    completeToolOperation(
      companion.db,
      begin.operationId,
      JSON.stringify({ ok: true, memoryId: 'mem-blue', revision: 1 }),
      now,
    )
    const row = companion.db
      .select()
      .from(toolOperations)
      .where(eq(toolOperations.id, begin.operationId))
      .get()
    expect(row?.status).toBe('committed')
    expect(row?.resultJson).toContain('mem-blue')
  })

  it('已成功后重复到达：拿回第一次的结果，库里仍只有一行（05 §5）', () => {
    const replay = beginToolOperation(companion.db, {
      operationKey,
      conversationId,
      toolName: 'remember_explicit',
      requestMessageId: messageId,
      now,
    })
    // 网络重放场景：什么都不该再执行，直接收到旧结果
    expect(replay.kind).toBe('already-committed')
    if (replay.kind !== 'already-committed') return
    expect(replay.resultJson).toContain('mem-blue')
    expect(companion.db.select().from(toolOperations).all()).toHaveLength(1)
  })
})

describe('失败重跑与单次落定（T04 步骤⑦）', () => {
  const operationKey = buildOperationKey({
    conversationId,
    requestMessageId: messageId,
    toolName: 'forget_memory',
    targetId: 'mem-old',
  })

  it('失败只记错误码不记正文，重跑复用原行', () => {
    const first = beginToolOperation(companion.db, {
      operationKey,
      conversationId,
      toolName: 'forget_memory',
      requestMessageId: messageId,
      targetId: 'mem-old',
      now,
    })
    expect(first.kind).toBe('new')
    if (first.kind !== 'new') return
    failToolOperation(companion.db, first.operationId, 'STORAGE_UNAVAILABLE', now)
    const failed = companion.db
      .select()
      .from(toolOperations)
      .where(eq(toolOperations.id, first.operationId))
      .get()
    expect(failed?.status).toBe('failed')
    expect(failed?.errorCode).toBe('STORAGE_UNAVAILABLE')
    expect(failed?.resultJson).toBeNull()

    // 重试：同一编号再来，复用原行重新执行（失败没写过东西，可以重跑）
    const retry = beginToolOperation(companion.db, {
      operationKey,
      conversationId,
      toolName: 'forget_memory',
      requestMessageId: messageId,
      targetId: 'mem-old',
      now,
    })
    expect(retry.kind).toBe('new')
    expect(retry.operationId).toBe(first.operationId)
    completeToolOperation(
      companion.db,
      first.operationId,
      JSON.stringify({ ok: true }),
      now,
    )
  })

  it('已落定的操作不许二次落定，不存在的一樣抛错', () => {
    // 上面 complete 过的这行现在是 committed：再 complete 必须炸出来，
    // 否则「已保存」的结果可能被后来者悄悄改写
    const row = companion.db
      .select()
      .from(toolOperations)
      .where(eq(toolOperations.operationKey, operationKey))
      .get()
    expect(row?.status).toBe('committed')
    expect(() =>
      completeToolOperation(companion.db, row!.id, '{"偷跑":"第二次结果"}', now),
    ).toThrow('已落定')
    expect(() =>
      failToolOperation(companion.db, 'op-no-such', 'NOT_FOUND', now),
    ).toThrow('不存在')
  })
})
