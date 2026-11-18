import { describe, expect, it } from 'vitest';
import { typeName } from '../src/debug/java.js';
import { frameName } from '../src/debug/session.js';
import { parseWorkspace } from '../src/mission/workspace.js';

describe('debugging', () => {
  it('shows .NET frames the way the code reads', () => {
    expect(frameName('ShopKart.Api.Orders.OrdersService.<CancelOrder>d__4.MoveNext()')).toBe('OrdersService.CancelOrder()');
    expect(frameName('Program.<>c.<<Main>$>b__0_8()')).toBe('Program (lambda)');
    expect(frameName('ShopKart.Api.Orders.OrdersService.ListOrders()')).toBe('OrdersService.ListOrders()');
    expect(frameName('[Native Frames]')).toBe('[Native Frames]');
  });

  it('names Java types from JVM signatures', () => {
    expect(typeName('Lcom/shopkart/orders/OrdersService;')).toBe('com.shopkart.orders.OrdersService');
    expect(typeName('[I')).toBe('int[]');
    expect(typeName('[[Ljava/lang/String;')).toBe('java.lang.String[][]');
  });

  it('reads a debug section, and refuses one that cannot work', () => {
    const base = 'version: 1\nname: x\nbranch: b\ndatabase: { engine: postgres, name: x }\ntest: [{ name: t, layer: backend, run: x, junit: x }]\n';
    expect(parseWorkspace(`${base}debug: { adapter: node, run: "node --inspect=127.0.0.1:{{ports.debug}} x.js" }`).debug?.adapter).toBe('node');
    expect(() => parseWorkspace(`${base}debug: { adapter: dotnet, run: x }`)).toThrow(/build/);
    expect(() => parseWorkspace(`${base}debug: { adapter: java, run: x }`)).toThrow(/sourceRoots/);
  });
});
