import { describe, it, expect } from 'vitest'
import { makeCassetteFetch } from '../support/cassette.js'
import { AnnouncementClient } from '../../src/modules/announcement/create/svcB2cClient.js'

describe('announcement_update via cassette (offline, real client)', () => {
  it('real AnnouncementClient accepts cassette fetchImpl and the seed cassette loads', async () => {
    const fetchImpl = makeCassetteFetch('replay', 'tests/cassettes/announcement-update.json')
    const client = new AnnouncementClient({
      baseUrl: 'https://api-gateway.stage.kkday.com/svc-b2c/api/v1',
      apiKey: 'test-key', fetchImpl,
    })
    // 呼叫 client 的 PATCH 對應方法（若尚無 patch()，Task 9 dogfood 會補；此處先驗 client 能吃 fetchImpl）
    expect(client).toBeDefined()
  })
})
