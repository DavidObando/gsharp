// <copyright file="Issue4738InheritedTupleArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic

class Issue4738InheritedTupleArgumentEmitTests {
    @Theory
    @InlineData(int32(0), int32(0), false)
    @InlineData(int32(0), int32(1), false)
    @InlineData(int32(0), int32(2), false)
    @InlineData(int32(1), int32(0), false)
    @InlineData(int32(1), int32(1), false)
    @InlineData(int32(1), int32(2), false)
    @InlineData(int32(2), int32(0), false)
    @InlineData(int32(2), int32(1), false)
    @InlineData(int32(2), int32(2), false)
    @InlineData(int32(0), int32(0), true)
    @InlineData(int32(0), int32(1), true)
    @InlineData(int32(0), int32(2), true)
    @InlineData(int32(1), int32(0), true)
    @InlineData(int32(1), int32(1), true)
    @InlineData(int32(1), int32(2), true)
    @InlineData(int32(2), int32(0), true)
    @InlineData(int32(2), int32(1), true)
    @InlineData(int32(2), int32(2), true)
    func InheritedOwner_LiteralPreservesPhysicalTupleAndOrderedEffects(owner int32, shape int32, valueElement bool) {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4738InheritedTupleArgumentEmitTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let contractPath = CompileContract(directory)
            let declarations = switch owner {
                case 0: "class Leaf[T] : List[T] {}"
                case 1: "open class Middle[A, B] : List[B] {}\nclass Leaf[T] : Middle[int32, T] {}"
                default: "class Leaf[T] : Reordered[string, T] {}"
            }
            let tuple = switch shape {
                case 0: "(entry Item, number int32)"
                case 1: "(outer int32, inner (entry Item, number int32))"
                default: "(int32, int32, int32, int32, int32, int32, int32, Item, int32)"
            }
            let literal = switch shape {
                case 0: "(counter.NextItem(2), counter.Mark(3))"
                case 1: "(counter.Mark(2), (counter.NextItem(3), counter.Mark(4)))"
                default: "(counter.Mark(2), counter.Mark(3), counter.Mark(4), counter.Mark(5), counter.Mark(6), counter.Mark(7), counter.Mark(8), counter.NextItem(9), counter.Mark(0))"
            }
            let source = (`package Issue4738.Consumer
import System.Collections.Generic
import Issue4738.Contracts
` + "${(if valueElement { "struct" } else { "class" })}" + ` Item(Label int32) {}
` + "$declarations" + `
class Counter(Values Leaf[` + "$tuple" + `], Entry Item) {
    var Trace int32 = 0
    func Mark(digit int32) int32 {
        Trace = Trace * 10 + digit
        return digit
    }
    func Receiver() Leaf[` + "$tuple" + `] {
        Mark(1)
        return Values
    }
    func NextItem(digit int32) Item {
        Mark(digit)
        return Entry
    }
}
public func Producer(counter Counter) Leaf[` + "$tuple" + `] {
    counter.Receiver().Add(` + "$literal" + `)
    return counter.Values
}
public func RoundTrip(value ` + "$tuple" + `) ` + "$tuple" + ` -> Native.Identity(value)
public func Box(value ` + "$tuple" + `) object -> value
public func NewItem() Item -> Item(37)`)
            let outputPath = Compile(directory, source, contractPath)
            IlVerifier.Verify(outputPath, additionalReferences: []string{contractPath})
            let assembly = EmittedFixture.LoadTogether(contractPath, outputPath)[1]
            let itemType = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Item")
            let leafDefinition = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Leaf`1")
            let pair = typeof(ValueTuple[_, _]).MakeGenericType(itemType, typeof(int32))
            let expectedTuple = switch shape {
                case 0: pair
                case 1: typeof(ValueTuple[_, _]).MakeGenericType(typeof(int32), pair)
                default: typeof(ValueTuple[_, _, _, _, _, _, _, _]).MakeGenericType(
                    typeof(int32),
                    typeof(int32),
                    typeof(int32),
                    typeof(int32),
                    typeof(int32),
                    typeof(int32),
                    typeof(int32),
                    pair
                )
            }
            let expectedLeaf = leafDefinition.MakeGenericType(expectedTuple)
            let producer = FindMethod(assembly, "Producer")
            let roundTrip = FindMethod(assembly, "RoundTrip")
            let box = FindMethod(assembly, "Box")
            Assert.Equal(expectedLeaf, producer.ReturnType)
            Assert.Equal(expectedTuple, roundTrip.ReturnType)
            Assert.Equal(expectedTuple, Assert.Single(roundTrip.GetParameters()).ParameterType)
            Assert.Equal(expectedTuple, Assert.Single(box.GetParameters()).ParameterType)
            let values = Assert.IsAssignableFrom[IList](Activator.CreateInstance(expectedLeaf))
            let item = Assert.IsAssignableFrom[object](FindMethod(assembly, "NewItem").Invoke(nil, nil))
            let counterType = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Counter")
            let counter = Assert.IsAssignableFrom[object](Activator.CreateInstance(counterType, values, item))
            Assert.Same(values, producer.Invoke(nil, []object{counter}))
            Assert.Equal(
                switch shape {
                    case 0: 123
                    case 1: 1234
                    default: 1234567890
                },
                counterType.GetField("Trace")!!.GetValue(counter)
            )
            let result = Assert.Single(values.Cast[object]())
            Assert.Equal(expectedTuple, result.GetType())
            Assert.Equal(result, roundTrip.Invoke(nil, []object{result}))
            Assert.Equal(result, box.Invoke(nil, []object{result}))
            let storedPair object? = switch shape {
                case 0: result
                case 1: expectedTuple.GetField("Item2")!!.GetValue(result)
                default: expectedTuple.GetField("Rest")!!.GetValue(result)
            }
            Assert.Equal(itemType, pair.GetField("Item1")!!.FieldType)
            Assert.Equal(typeof(int32), pair.GetField("Item2")!!.FieldType)
            let storedItem object? = pair.GetField("Item1")!!.GetValue(storedPair)
            if valueElement {
                Assert.Equal(item, storedItem)
            } else {
                Assert.Same(item, storedItem)
            }
            Assert.Equal(37, itemType.GetField("Label")!!.GetValue(storedItem))
            Assert.Equal(
                switch shape {
                    case 0: 3
                    case 1: 4
                    default: 0
                },
                pair.GetField("Item2")!!.GetValue(storedPair)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func OpenInheritedOwnerAndGenericMethod_PreserveBothSymbolicArgumentVectors() {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4738InheritedTupleArgumentEmitTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let contractPath = CompileContract(directory)
            let outputPath = Compile(directory, `package Issue4738.OpenConsumer
import System.Collections.Generic
import Issue4738.Contracts
class Item(Label int32) {}
class Leaf[T] : List[(entry T, number int32)] {}
class PairLeaf[T] : PairOwner[string, T] {}
public func Producer[T](item T) Leaf[T] {
    let leaf = Leaf[T]()
    leaf.Add((item, 7))
    return leaf
}
public func Keep(item Item) (Item, int32) -> PairLeaf[Item]().Keep((item, 11))
public func Mix[U](item Item, value U) object -> PairLeaf[Item]().Mix[U]((item, value))
public func NewItem() Item -> Item(37)`, contractPath)
            IlVerifier.Verify(outputPath, additionalReferences: []string{contractPath})
            let loaded = EmittedFixture.LoadTogether(contractPath, outputPath)
            let assembly = loaded[1]
            let item = Assert.IsAssignableFrom[object](FindMethod(assembly, "NewItem").Invoke(nil, nil))
            let markerType = Assert.Single(loaded[0].GetTypes(), (type Type) -> type.Name == "Marker")
            let marker = Assert.IsAssignableFrom[object](Activator.CreateInstance(markerType, 41))
            let producer = FindMethod(assembly, "Producer")
            let genericArgument = Assert.Single(producer.GetGenericArguments())
            Assert.Equal(
                typeof(ValueTuple[_, _]).MakeGenericType(genericArgument, typeof(int32)),
                Assert.Single(producer.ReturnType.BaseType!!.GetGenericArguments())
            )
            for value in[]object{item, marker, object(43)} {
                let values = Assert.IsAssignableFrom[IList](
                    producer.MakeGenericMethod(value.GetType()).Invoke(nil, []object{value})
                )
                let pair = Assert.Single(values.Cast[object]())
                let tuple = typeof(ValueTuple[_, _]).MakeGenericType(value.GetType(), typeof(int32))
                Assert.Equal(tuple, pair.GetType())
                Assert.Equal(value.GetType(), tuple.GetField("Item1")!!.FieldType)
                if value is int32 {
                    Assert.Equal(value, tuple.GetField("Item1")!!.GetValue(pair))
                } else {
                    Assert.Same(value, tuple.GetField("Item1")!!.GetValue(pair))
                }
                Assert.Equal(7, tuple.GetField("Item2")!!.GetValue(pair))
            }
            let keep = Assert.IsAssignableFrom[object](FindMethod(assembly, "Keep").Invoke(nil, []object{item}))
            Assert.Same(item, keep.GetType().GetField("Item1")!!.GetValue(keep))
            Assert.Equal(11, keep.GetType().GetField("Item2")!!.GetValue(keep))
            let mix = FindMethod(assembly, "Mix")
            Assert.Equal(typeof(object), mix.ReturnType)
            for value in[]object{marker, object(47)} {
                let pair = Assert.IsAssignableFrom[object](
                    mix.MakeGenericMethod(value.GetType()).Invoke(nil, []object{item, value})
                )
                Assert.Equal(typeof(ValueTuple[_, _]).MakeGenericType(item.GetType(), value.GetType()), pair.GetType())
                Assert.Same(item, pair.GetType().GetField("Item1")!!.GetValue(pair))
                Assert.Equal(value, pair.GetType().GetField("Item2")!!.GetValue(pair))
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData("class Leaf[T] : List[T] {}")
    @InlineData("class Leaf[T] : Reordered[string, T] {}")
    func InheritedOwner_ErasedObjectTupleCannotReachOpenSlot(declaration string) {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4738InheritedTupleArgumentEmitTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let contractPath = CompileContract(directory)
            let sourcePath = Path.Combine(directory, "Rejected.gs")
            let outputPath = Path.Combine(directory, "Rejected.dll")
            File.WriteAllText(sourcePath, (`package Issue4738.Rejected
import System.Collections.Generic
import Issue4738.Contracts
` + "$declaration" + `
public func Unsafe[T](leaf Leaf[(T, int32)], pair (object, int32)) {
    leaf.Add(pair)
}`))
            let (exitCode, output) = RunCompiler(sourcePath, outputPath, contractPath)
            Assert.NotEqual(0, exitCode)
            Assert.Contains("error GS0155:", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
            Assert.False(File.Exists(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private const ContractSource string = `#nullable enable
namespace Issue4738.Contracts;
public class Reordered<A, B> : System.Collections.Generic.List<B> { }
public sealed class Marker
{
    public Marker(int label) => Label = label;
    public int Label { get; }
}
public class PairOwner<A, B>
{
    public (B, int) Keep((B, int) value) => value;
    public object Mix<U>((B, U) value) => value;
}
public class ReturnOwner<A, B>
{
    public (B, U) Mix<U>((B, U) value) => value;
    public (B, V, U, A) Vector<U, V>((B, V, U, A) value) => value;
    public (B, U) Reference<U>((B, U) value) where U : class => value;
    public (B, U) Value<U>((B, U) value) where U : struct => value;
}
public class ReorderedReturnOwner<A, B> : ReturnOwner<B, A> { }
public class NestedReturnOwner<A, B> : ReturnOwner<A, System.Collections.Generic.List<B>> { }
public static class Native
{
    public static T Identity<T>(T value) => value;
}`

        internal func CompileContract(directory string) string {
            let contractPath = Path.Combine(directory, "Issue4738.Contracts.dll")
            let compilation = CSharpCompilation.Create(
                "Issue4738.Contracts",
                []SyntaxTree{CSharpSyntaxTree.ParseText(ContractSource)},
                ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                    (path string) -> MetadataReference.CreateFromFile(path)
                ),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(contractPath)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return contractPath
        }

        internal func FindMethod(assembly Assembly, name string) MethodInfo -> Assert.Single(
            assembly.GetTypes().SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(BindingFlags.Public | BindingFlags.Static)
                }
            ),
            (method MethodInfo) -> method.Name == name
        )

        internal func Compile(directory string, source string, contractPath string) string {
            let sourcePath = Path.Combine(directory, "Consumer.gs")
            let outputPath = Path.Combine(directory, "Consumer.dll")
            File.WriteAllText(sourcePath, source)
            let (exitCode, output) = RunCompiler(sourcePath, outputPath, contractPath)
            Assert.True(exitCode == 0, output)
            return outputPath
        }

        internal func RunCompiler(sourcePath string, outputPath string, contractPath string)(
            ExitCode int32,
            Output string
        ) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            var exitCode int32
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                exitCode = Program.Main(
                    []string{
                        sourcePath,
                        "/target:library",
                        "/targetframework:net10.0",
                        "/r:" + contractPath,
                        "/out:" + outputPath
                    }
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (exitCode, stdout.ToString() + stderr.ToString())
        }
    }
}
