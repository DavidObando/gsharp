// <copyright file="Issue4065MethodGroupValueDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.IO
import System.Linq
import Xunit

/// Emit-path regressions for issue #4065.
class Issue4065MethodGroupValueDiagnosticTests {
    @Fact
    func OriginalRepro_StopsAtPublicDiagnosticBeforeEmit() {
        let result = Emit(`package Demo
import System
import System.Collections.Generic

func main2() {
    let values = List[int32]()
    Console.WriteLine(values.Add.ToString())
}

main2()`)
        let diagnostic = Assert.Single(result.Diagnostics.Where((item Diagnostic) -> item.IsError))
        Assert.Equal("GS0582", diagnostic.Id)
        Assert.Equal("Add", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.DoesNotContain(result.Diagnostics, (item Diagnostic) -> item.Id == "GS9998")
    }

    @Fact
    func CallsAndTargetTypedMethodGroups_EmitSuccessfully() {
        let result = Emit(`package Demo
import System
import System.Collections.Generic
import System.Linq

func Use(action Action[int32]) {
    action.Invoke(3)
}

func Pick(values List[int32]) Action[int32] {
    return values.Add
}

func main2() {
    let values = List[int32]()
    values.Add(1)
    Use(values.Add)
    let add Action[int32] = values.Add
    add.Invoke(4)
    let selected Action[int32] = true ? values.Add : values.Add
    selected.Invoke(5)

    let maybeValues List[int32]? = values
    let count Func[int32] = maybeValues.Count
    Console.WriteLine(maybeValues.Count())
    Console.WriteLine(count.Invoke())
    Pick(values).Invoke(6)
    Console.WriteLine(values.Count)
}

main2()`)
        Assert.Empty(result.Diagnostics)
        Assert.True(result.Success)
    }

    shared {
        private func Emit(source string) EmitResult {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            using let output = MemoryStream()
            return compilation.Emit(output)
        }
    }
}
