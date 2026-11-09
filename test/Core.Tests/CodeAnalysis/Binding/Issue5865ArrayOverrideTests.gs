package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

class Issue5865ArrayOverrideTests {
    @Fact
    func CovariantContainersDoNotMakeNestedMutablePositionsCovariant() {
        using let contract = CSharpFixture(`#nullable enable
using System.Collections.Generic;
namespace Array5865;
public sealed class Box {}
public abstract class Mutable { public abstract IEnumerable<Box[]> Read(); }
public abstract class ReadOnly { public abstract IEnumerable<Box?> Read(); }`)
        let valid = EmittedOracle.Evaluate([]string{`package Array5865
import System.Collections.Generic
class Rows : ReadOnly {
override func Read() List[Box] -> List[Box]{Box()}
}`}, EmittedOracleOptions{IsLibrary: true, References: []string{contract.AssemblyPath}})
        Assert.Empty(valid.Diagnostics)
        let invalid = EmittedOracle.Evaluate([]string{`package Array5865
import System.Collections.Generic
class Rows : Mutable {
override func Read() List[[]Box?] -> List[[]Box?]{[]Box?{nil}}
}`}, EmittedOracleOptions{IsLibrary: true, References: []string{contract.AssemblyPath}})
        let diagnostic = Assert.Single(invalid.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0185"))
        Assert.Equal(3, diagnostic.Location.StartLine)
    }

    @Theory
    @InlineData("Box[]", "[]Box")
    @InlineData("Box[,]", "[,]Box")
    @InlineData("Box[][]", "[][]Box")
    @InlineData("(Box[] Items, int Code)", "(Items []Box, Code int32)")
    @InlineData("Task<Box[]>", "Task[[]Box]")
    @InlineData("ValueTask<Box[]>", "ValueTask[[]Box]")
    @InlineData("List<Box>", "List[Box]")
    @InlineData("Dictionary<string, Box>", "Dictionary[string, Box]")
    func MutableReturnPositionsAreInvariant(nativeType string, sourceType string) {
        for nullableBase in[]bool{false, true} {
            let nativeReturn = if nullableBase {
                nativeType.Replace("Box", "Box?")
            } else {
                nativeType
            }
            using let contract = CSharpFixture(
                "#nullable enable\nusing System.Collections.Generic;\nusing System.Threading.Tasks;\nnamespace Array5865;\n" +
                    "public sealed class Box {}\npublic abstract class Contract { public abstract $nativeReturn Read(); }"
            )
            let matching = if nullableBase {
                sourceType.Replace("Box", "Box?")
            } else {
                sourceType
            }
            let mismatch = if nullableBase {
                sourceType
            } else {
                sourceType.Replace("Box", "Box?")
            }
            let prefix = "package Array5865\nimport System.Collections.Generic\nimport System.Threading.Tasks\nclass Rows : Contract {\n"
            let suffix = " -> throw System.Exception()\n}"
            let invalid = EmittedOracle.Evaluate(
                []string{prefix + "override func Read() $mismatch" + suffix},
                EmittedOracleOptions{IsLibrary: true, References: []string{contract.AssemblyPath}}
            )
            let diagnostic = Assert.Single(invalid.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0185"))
            Assert.Equal(4, diagnostic.Location.StartLine)
            let valid = EmittedOracle.Evaluate(
                []string{prefix + "override func Read() $matching" + suffix},
                EmittedOracleOptions{IsLibrary: true, References: []string{contract.AssemblyPath}}
            )
            Assert.Empty(valid.Diagnostics)
        }
    }
}
