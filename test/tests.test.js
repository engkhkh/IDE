// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scanSource, parseTrx, escapeFilter, parseDuration } = require('../main/tests');

test('scanner: xUnit with file-scoped namespace, skip, theory, async', () => {
  const src = `using Xunit;
namespace Calc.Tests;

public class CalculatorTests
{
    [Fact]
    public void Add_Works() { Assert.Equal(2, 1 + 1); }

    [Fact(Skip = "not yet")]
    public void Later() { }

    [Theory]
    [InlineData(1, 2)]
    public void Many(int a, int b) { }

    // [Fact] public void Commented() { }
    [Fact]
    public async Task Async_Works()
    {
        var s = "{ not a brace } // nor a comment";
        await Task.Yield();
    }

    public void Helper() { }
}`;
  const t = scanSource(src, 'C.cs');
  assert.deepStrictEqual(t.map((x) => `${x.fqn}@${x.line}`), ['Calc.Tests.CalculatorTests.Add_Works@7', 'Calc.Tests.CalculatorTests.Later@10', 'Calc.Tests.CalculatorTests.Many@14', 'Calc.Tests.CalculatorTests.Async_Works@18']);
  assert.strictEqual(t[1].skip, 'not yet');
  assert.strictEqual(t[2].data, true);
});

test('scanner: NUnit + MSTest, block namespaces, nested classes, attributes on one line', () => {
  const src = `namespace Outer
{
    namespace Inner
    {
        [TestFixture]
        public class Suite
        {
            [Test, Category("fast")]
            public void One() { if (true) { } }

            [TestCase(1)] [TestCase(2)]
            public void Two(int x) { }

            public class Nested
            {
                [Test] public void Three() { }
            }
        }
    }
}
namespace Other { [TestClass] public class MsTests { [TestMethod] public void Four() { } [DataTestMethod] [DataRow(1)] public void Five(int x) { } } }`;
  const t = scanSource(src, 'S.cs');
  assert.deepStrictEqual(t.map((x) => x.fqn), ['Outer.Inner.Suite.One', 'Outer.Inner.Suite.Two', 'Outer.Inner.Suite+Nested.Three', 'Other.MsTests.Four', 'Other.MsTests.Five']);
  assert.deepStrictEqual(t.map((x) => x.line), [9, 12, 16, 21, 21]);
});

test('TRX: results with outcomes, messages, stack, stdout, durations', () => {
  const r = parseTrx(fs.readFileSync(path.join(__dirname, 'fixtures', 'results.trx'), 'utf8'));
  assert.strictEqual(r.total, 9);
  const by = Object.fromEntries(r.results.map((x) => [x.name, x]));
  const mul = by['Calc.Tests.CalculatorTests.Multiply_TwoNumbers_ReturnsProduct'];
  assert.strictEqual(mul.outcome, 'failed');
  assert.match(mul.message, /Expected: 12\nActual:\s+13/);
  assert.match(mul.stack, /CalculatorTests\.cs:line 24/);
  assert.strictEqual(mul.stdout, 'Multiplying 3 x 4');
  assert.strictEqual(mul.className, 'Calc.Tests.CalculatorTests');
  assert.strictEqual(mul.fqn, 'Calc.Tests.CalculatorTests.Multiply_TwoNumbers_ReturnsProduct');
  assert.strictEqual(by['Calc.Tests.CalculatorTests.Power_NotImplemented'].outcome, 'skipped');
  const theory = r.results.filter((x) => x.method === 'Add_Theory');
  assert.strictEqual(theory.length, 3);
  assert.ok(theory.every((x) => x.fqn === 'Calc.Tests.CalculatorTests.Add_Theory'));
  assert.strictEqual(r.results.filter((x) => x.outcome === 'passed').length, 6);
});

test('filter escaping and durations', () => {
  assert.strictEqual(escapeFilter('A.B(1, 2)'), 'A.B\\(1, 2\\)');
  assert.strictEqual(parseDuration('00:01:02.5000000'), 62500);
});

// found in a real project (NexusMQ AccessTests): one-line tests whose expression body creates an object
test('one-line test with "=> new X(...)" body is discovered', () => {
  const src = [
    'namespace NexusMQ.Tests;',
    'public class AccessTests',
    '{',
    '    [Fact] public void Open_when_no_keys_configured() => new NexusAuthorizer(new NexusServerOptions()).Demand(null, NexusRights.Manage, null);',
    '    [Fact] public void Missing_key_is_unauthorized() => Assert.Equal(1, Denied(null));',
    '    [Fact] public async Task Creates() { var x = new List<int>(); await Task.Yield(); }',
    '    private static Foo Make() => new Foo();',
    '}'
  ].join('\n');
  const r = scanSource(src, '/x/AccessTests.cs');
  assert.deepStrictEqual(r.map((t) => t.method), ['Open_when_no_keys_configured', 'Missing_key_is_unauthorized', 'Creates']);
  assert.strictEqual(r[0].fqn, 'NexusMQ.Tests.AccessTests.Open_when_no_keys_configured');
});
