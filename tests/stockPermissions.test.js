import test from "node:test";
import assert from "node:assert/strict";
import router from "../routes/index.js";
import { MOVEMENT_ROLES, canRecordMovement, requireMovementPermission } from "../services/permissions.js";

const user = role => ({ isActive: true, Role: { name: role } });

test("stock in/out need an inventory role; adjustments are manager-only", () => {
  for (const role of ["staff", "supervisor", "manager"]) {
    assert.equal(canRecordMovement(user(role), "stock_in"), true, role);
    assert.equal(canRecordMovement(user(role), "stock_out"), true, role);
  }
  assert.equal(canRecordMovement(user("manager"), "adjustment"), true);
  assert.equal(canRecordMovement(user("supervisor"), "adjustment"), false);
  assert.equal(canRecordMovement(user("staff"), "adjustment"), false);
  assert.equal(canRecordMovement(user("guest"), "stock_in"), false);
  assert.equal(canRecordMovement({ isActive: true, Role: null }, "stock_out"), false);
  assert.equal(canRecordMovement({ ...user("manager"), isActive: false }, "adjustment"), false);
  assert.equal(canRecordMovement(user("manager"), "teleport"), false);
  assert.ok(Object.isFrozen(MOVEMENT_ROLES.adjustment));
});

test("the movement form and submit routes run the permission guard", () => {
  for (const [path, method] of [["/inventory/:type", "get"], ["/inventory/movements/:type", "post"]]) {
    const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
    assert.ok(layer, path);
    assert.ok(layer.route.stack.some(item => item.handle === requireMovementPermission), path);
  }
});

test("the guard redirects a staff adjustment and lets a manager through", () => {
  const run = (role, type) => {
    const flashes = [];
    let redirected = null;
    let passed = false;
    requireMovementPermission(
      { user: user(role), params: { type }, flash: (kind, message) => flashes.push([kind, message]) },
      { redirect: path => { redirected = path; } },
      () => { passed = true; }
    );
    return { flashes, redirected, passed };
  };
  const staff = run("staff", "adjustment");
  assert.equal(staff.passed, false);
  assert.equal(staff.redirected, "/inventory");
  assert.match(staff.flashes[0][1], /managers/);
  assert.equal(run("staff", "stock-in").passed, true);
  assert.equal(run("manager", "adjustment").passed, true);
});
