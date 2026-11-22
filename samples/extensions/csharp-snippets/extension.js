// Sample Nova IDE extension: Visual Studio style C# snippets
nova.register({
  activate(ctx) {
    ctx.languages.registerSnippets('csharp', [
      { prefix: 'prop', description: 'Auto-implemented property', body: 'public ${1:int} ${2:MyProperty} { get; set; }$0' },
      { prefix: 'propfull', description: 'Property with backing field', body: ['private ${1:int} ${2:myVar};', '', 'public ${1:int} ${3:MyProperty}', '{', '    get => ${2:myVar};', '    set => ${2:myVar} = value;', '}$0'] },
      { prefix: 'ctor', description: 'Constructor', body: ['public ${1:ClassName}(${2})', '{', '    $0', '}'] },
      { prefix: 'cw', description: 'Console.WriteLine', body: 'Console.WriteLine($1);$0' },
      { prefix: 'for', description: 'for loop', body: ['for (int ${1:i} = 0; ${1:i} < ${2:length}; ${1:i}++)', '{', '    $0', '}'] },
      { prefix: 'foreach', description: 'foreach loop', body: ['foreach (var ${1:item} in ${2:collection})', '{', '    $0', '}'] },
      { prefix: 'if', description: 'if statement', body: ['if (${1:true})', '{', '    $0', '}'] },
      { prefix: 'try', description: 'try / catch', body: ['try', '{', '    $1', '}', 'catch (${2:Exception} ${3:ex})', '{', '    $0', '}'] },
      { prefix: 'class', description: 'Class', body: ['public class ${1:MyClass}', '{', '    $0', '}'] },
      { prefix: 'interface', description: 'Interface', body: ['public interface I${1:MyInterface}', '{', '    $0', '}'] },
      { prefix: 'record', description: 'Record', body: 'public record ${1:MyRecord}(${2:string Name});$0' },
      { prefix: 'switch', description: 'switch statement', body: ['switch (${1:value})', '{', '    case ${2:0}:', '        $0', '        break;', '    default:', '        break;', '}'] },
      { prefix: 'async', description: 'async method', body: ['public async Task${1:<${2:T}>} ${3:MethodAsync}()', '{', '    $0', '}'] },
      { prefix: 'test', description: 'xUnit test method', body: ['[Fact]', 'public void ${1:Method_Scenario_Expected}()', '{', '    // Arrange', '    $0', '    // Act', '', '    // Assert', '}'] }
    ]);
  }
});
