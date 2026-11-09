package GSharp.Compiler.Tests

import System
import System.IO
import System.Text
import Xunit

class Issue5865ArrayOverrideDriverTests {
    @Theory
    @InlineData("array")
    @InlineData("rectangular")
    @InlineData("jagged")
    @InlineData("Task")
    @InlineData("ValueTask")
    @InlineData("async-Task")
    @InlineData("async-ValueTask")
    @InlineData("List")
    @InlineData("Dictionary")
    func MutableNativeReturnContractsRejectMismatchesAndPreserveObliviousness(shape string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let isAsync = shape.StartsWith("async-", StringComparison.Ordinal)
        let envelope = shape.Replace("async-", "")
        let wrapped = envelope == "Task" || envelope == "ValueTask"
        let nativeType = switch envelope {
            case "rectangular": "Box[,]"
            case "jagged": "Box[][]"
            case "List": "List<Box>"
            case "Dictionary": "Dictionary<string, Box>"
            default: "Box[]"
        }
        let sourceType = switch envelope {
            case "rectangular": "[,]Box"
            case "jagged": "[][]Box"
            case "List": "List[Box]"
            case "Dictionary": "Dictionary[string, Box]"
            default: "[]Box"
        }
        let sourceValue = switch envelope {
            case "rectangular": "[1, 1]Box{Box()}"
            case "jagged": "[][]Box{[]Box{Box()}}"
            case "List": "List[Box]{Box()}"
            case "Dictionary": "Dictionary[string, Box]{\"key\": Box()}"
            default: "[]Box{Box()}"
        }
        let element = switch envelope {
            case "rectangular": "values[0, 0]"
            case "jagged": "values[0][0]"
            case "Dictionary": "values[\"key\"]"
            default: "values[0]"
        }
        for context in[]string{"enable", "disable"} {
            for nullableBase in[]bool{false, true} {
                if context == "disable" && nullableBase {
                    continue
                }
                let nativeResult = if nullableBase {
                    nativeType.Replace("Box", "Box?")
                } else {
                    nativeType
                }
                let nativeReturn = if wrapped {
                    "$envelope<$nativeResult>"
                } else {
                    nativeResult
                }
                let read = if wrapped {
                    "rows.Read().GetAwaiter().GetResult()"
                } else {
                    "rows.Read()"
                }
                let name = "native" + context + nullableBase.ToString()
                let native = fixture.CompileCSharp(
                    "#nullable $context\nusing System.Collections.Generic;\nusing System.Threading.Tasks;\nnamespace Array5865;\n" +
                        "public sealed class Box {}\npublic abstract class Contract { public abstract $nativeReturn Read(); }\n" +
                        "public static class Observer { public static int Probe(Contract rows) { var values = $read; return $element == null ? 7 : 9; } }",
                    name
                )
                for nullableSource in[]bool{false, true} {
                    let resultType = if nullableSource {
                        sourceType.Replace("Box", "Box?")
                    } else {
                        sourceType
                    }
                    let value = if nullableSource {
                        sourceValue.Replace("Box", "Box?").Replace("Box?()", "nil")
                    } else {
                        sourceValue
                    }
                    let returnType = if wrapped && (!isAsync || envelope == "ValueTask") {
                        "$envelope[$resultType]"
                    } else {
                        resultType
                    }
                    let result = if !wrapped || isAsync {
                        value
                    } else if envelope == "Task" {
                        "Task.FromResult[$resultType]($value)"
                    } else {
                        "ValueTask[$resultType]($value)"
                    }
                    let modifier = if isAsync {
                        "async "
                    } else {
                        ""
                    }
                    let source = "package Array5865\nimport System\nimport System.Collections.Generic\nimport System.Threading.Tasks\n" +
                        "class Rows : Contract {\n    override ${modifier}func Read() $returnType -> $result\n}\n" +
                        "Console.Write(Observer.Probe(Rows()))"
                    let outputName = "rows" + context + nullableBase.ToString() + nullableSource.ToString()
                    if context == "enable" && nullableBase != nullableSource {
                        let (code, diagnostics) = fixture.TryCompile(source, outputName, true, "/r:" + native)
                        Assert.NotEqual(0, code)
                        Assert.Contains("error GS0185", diagnostics, StringComparison.Ordinal)
                        Assert.Contains(".gs(6,", diagnostics, StringComparison.Ordinal)
                        Assert.False(File.Exists(Path.Combine(fixture.Directory, outputName + ".dll")))
                    } else {
                        let dll = fixture.Compile(source, outputName, true, "/r:" + native)
                        IlVerifier.Verify(dll, []string{native})
                        Assert.Equal(
                            Encoding.UTF8.GetBytes(
                                if nullableSource {
                                    "7"
                                } else {
                                    "9"
                                }
                            ),
                            fixture.RunBytes(dll)
                        )
                    }
                }
            }
        }
    }
}
