// <copyright file="Issue2546MethodGroupGenericInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

open class Issue2546MethodGroupGenericInferenceTests {
    @Fact
    func ImportedMethodGroup_Select_InfersResultAndRuns() {
        const Source = `
package ImportedMethodGroup
import System
import System.Collections.Generic
import System.Linq

func main() int32 {
    var values = List[string]()
    values.Add("20")
    values.Add("22")
    return values.Select(Int32.Parse).Sum()
}
`
        Assert.Equal(42, CompileAndRun(Source, "ImportedMethodGroup_Select_InfersResultAndRuns"))
    }

    @Fact
    func OverloadedSourceMethodGroup_Select_InfersResultAndRuns() {
        const Source = `
package SourceMethodGroup
import System
import System.Collections.Generic
import System.Linq

func ConvertValue(s string) int32 { return Int32.Parse(s) }
func ConvertValue(n int32) string { return n.ToString() }

func main() int32 {
    var values = List[string]()
    values.Add("40")
    values.Add("2")
    return values.Select(ConvertValue).Sum()
}
`
        Assert.Equal(42, CompileAndRun(Source, "OverloadedSourceMethodGroup_Select_InfersResultAndRuns"))
    }

    @Fact
    func ImportedMethodGroup_StaticGenericApi_InfersResultAndRuns() {
        const Source = `
package StaticGenericApi
import System

func main() int32 {
    var values = []string{ "40", "2" }
    var parsed = Array.ConvertAll(values, Int32.Parse)
    return parsed[0] + parsed[1]
}
`
        Assert.Equal(42, CompileAndRun(Source, "ImportedMethodGroup_StaticGenericApi_InfersResultAndRuns"))
    }

    @Fact
    func GenericSourceMethodGroup_Select_UserElementToDictionary_InfersResultAndRuns() {
        const Source = `
package DictionaryMethodGroup
import System
import System.Collections.Generic
import System.Linq

data class Record(Value string) {}

class Repro {
    shared {
        func ToDictionary[T any](record T) Dictionary[string, string] {
            var result = Dictionary[string, string]()
            result.Add("value", "present")
            return result
        }

        func Run(records IEnumerable[Record]) int32 {
            return records.Select(ToDictionary).Single().Count
        }
    }
}

func main() int32 {
    var records = List[Record]()
    records.Add(Record("42"))
    return Repro.Run(records)
}
`
        Assert.Equal(
            1,
            CompileAndRun(Source, "GenericSourceMethodGroup_Select_UserElementToDictionary_InfersResultAndRuns")
        )
    }

    @Fact
    func SourceMethodGroup_Select_InsideLambda_UsesLexicalOwnerAndRuns() {
        const Source = `
package NestedDictionaryMethodGroup
import System
import System.Collections.Generic
import System.Linq

data class Record(Value string) {}

class Repro {
    shared {
        func ToDictionary(record Record) Dictionary[string, string] {
            var result = Dictionary[string, string]()
            result.Add("value", record.Value)
            return result
        }

        func Run(records IEnumerable[Record]) int32 {
            var nested Func[int32] = () -> records.Select(ToDictionary).Single().Count
            return nested()
        }
    }
}

func main() int32 {
    var records = List[Record]()
    records.Add(Record("42"))
    return Repro.Run(records)
}
`
        Assert.Equal(1, CompileAndRun(Source, "SourceMethodGroup_Select_InsideLambda_UsesLexicalOwnerAndRuns"))
    }

    @Fact
    func InstanceMethodGroup_Where_RejectsIndexedOverloadAndRuns() {
        const Source = `
package InstancePredicateMethodGroup
import System.Collections.Generic
import System.Linq

func main() int32 {
    var selected = List[string]()
    selected.Add("present")
    selected.Add("missing")
    var byKey = Dictionary[string, int32]()
    byKey.Add("present", 42)
    return selected.Where(byKey.ContainsKey).Select((key string) -> byKey[key]).Single()
}
`
        Assert.Equal(42, CompileAndRun(Source, "InstanceMethodGroup_Where_RejectsIndexedOverloadAndRuns"))
    }

    @Fact
    func ConstructedList_CapacityFromUserElementReadOnlyListCount_Runs() {
        const Source = `
package UserElementCollectionCount
import System.Collections.Generic

data class Session(Name string) {}

func Capacity(sessions IReadOnlyList[Session]) int32 {
    var rows = List[string](sessions!!.Count)
    return rows.Capacity
}

func main() int32 {
    var sessions = List[Session]()
    sessions.Add(Session("one"))
    return Capacity(sessions)
}
`
        Assert.Equal(1, CompileAndRun(Source, "ConstructedList_CapacityFromUserElementReadOnlyListCount_Runs"))
    }

    @Fact
    func ErroneousReceiver_Count_DoesNotProduceMethodGroupDiagnostic() {
        const Source = `
package ErrorRecovery
import System.Collections.Generic

func main() {
    var rows = List[string](missing!!.Count)
}
`
        using let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(Source)))
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0125")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0218")
    }

    @Fact
    func AmbiguousGenericSourceMethodGroup_DoesNotInferArbitraryResult() {
        const Source = `
package AmbiguousGenericMethodGroup
import System.Collections.Generic
import System.Linq

func Project[T any](value T) int32 { return 1 }
func Project[T any](value List[T]) string { return "x" }

func main() {
    var values = List[List[string]]()
    values.Select(Project)
}
`
        using let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(Source)))
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func AmbiguousSourceMethodGroup_DoesNotInferArbitraryResult() {
        const Source = `
package AmbiguousMethodGroup
import System
import System.Collections.Generic
import System.Linq

func Project(x IComparable) int32 { return 1 }
func Project(x ICloneable) string { return "x" }

func main() {
    var values = List[string]()
    values.Select(Project)
}
`
        using let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(Source)))
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    shared {
        private func CompileAndRun(source string, contextName string) object? {
            using let peStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let assembly = loadContext.LoadFromStream(peStream)
                let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
                let main MethodInfo? = program.GetMethod(
                    "main",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(main)
                return main!!.Invoke(nil, nil)
            } finally {
                loadContext.Unload()
            }
        }
    }
}
