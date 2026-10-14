// <copyright file="GenericMethodUserTypeArgUnderReferencesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import Binder = GSharp.Core.CodeAnalysis.Binding.Binder
import GSharp.Core.Tests
import System.Collections.Generic

/// Regression tests for issue #320: imported generic methods called with an
/// explicit <em>user-defined</em> type as the type argument
/// (`Array.Empty[Clock]()`, `Activator.CreateInstance[Clock]()`,
/// `provider.GetService[Clock]()`) must resolve when references are supplied
/// explicitly (the SDK `/r:` build path), which loads them into an isolated
/// (cref:System.Reflection.MetadataLoadContext).
///
/// A user-defined type is a (cref:StructSymbol) with a `null`
/// `ClrType` during binding, so the explicit type-argument resolution path
/// rejected it before ever attempting `MakeGenericMethod`, producing
/// `GS0159: Cannot find function`. The fix closes the open generic method
/// with a `System.Object` placeholder (so applicability checking succeeds)
/// while carrying the real user-type symbols to the emitter, which encodes the
/// true user-type token in the method specification.
open class GenericMethodUserTypeArgUnderReferencesTests {
    @Fact
    func Static_Generic_Method_With_UserType_Arg_Resolves_Under_Explicit_References() {
        let source = `package App
import System

class Clock {
}

func main() {
    var arr = Array.Empty[Clock]()
    Console.WriteLine(arr.Length)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Activator_CreateInstance_With_UserType_Arg_Resolves_Under_Explicit_References() {
        let source = `package App
import System

class Clock {
    var Ticks int32
    func Read() int32 {
        return Ticks
    }
}

func main() {
    var c = Activator.CreateInstance[Clock]()
    Console.WriteLine(c.Read())
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func BclType_Arg_Still_Resolves_Under_Explicit_References() {
        // Regression guard for issue #311: an all-BCL explicit type argument must
        // continue to bind exactly as before the user-type placeholder change.
        let source = `package App
import System

func main() {
    var arr = Array.Empty[string]()
    Console.WriteLine(arr.Length)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func UserClass_DerivingImportedBase_Satisfies_GenericBaseConstraint() {
        let source = `package App
import System
import System.Reflection

class DemoAttribute : Attribute {
}

func main() {
    var attr = CustomAttributeExtensions.GetCustomAttribute[DemoAttribute](typeof(int32))
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func UserClass_DerivingImportedBase_InLaterFile_Satisfies_GenericBaseConstraint() {
        const callSource = `package App
import System
import System.Reflection

func main() {
    var attr = CustomAttributeExtensions.GetCustomAttribute[DemoAttribute](typeof(int32))
}`
        const typeSource = `package App
import System

class DemoAttribute : Attribute {
}`
        Assert.Empty(Bind(callSource, typeSource))
    }

    @Fact
    func LiveReflection_UserClass_DerivingImportedBase_Satisfies_GenericBaseConstraint() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

class Derived : LiveConstraintBase {
}

func main() {
    LiveConstraintHost.Accept[Derived]()
}`
        Assert.Empty(BindLive(source))
    }

    @Fact
    func LiveReflection_ExpandedParams_PreservesUnconstrainedUserTypeArgument() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

class Derived : LiveConstraintBase {
}

class Other {
}

func main() {
    LiveConstraintHost.AcceptPair[Derived, Other]()
}`
        EmitAndInvokeLive(source)
    }

    @Fact
    func LiveReflection_InferredExpandedParams_PreservesUserElementType() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

class Derived : LiveConstraintBase {
}

func main() {
    LiveConstraintHost.AcceptInferred(Derived())
}`
        EmitAndInvokeLive(source)
    }

    @Fact
    func LiveReflection_InferredExpandedParams_WithDifferentUserTypes_UsesErasedCommonType() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

class First {
}

class Second {
}

func main() {
    LiveConstraintHost.AcceptAny(First(), Second())
}`
        EmitAndInvokeLive(source)
    }

    @Fact
    func LiveReflection_ExpandedParams_PreservesUserStructElementType() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

struct Item {
}

func main() {
    LiveConstraintHost.AcceptStruct(default(Item))
}`
        EmitAndInvokeLive(source)
    }

    @Fact
    func LiveReflection_ExpandedParams_ReportsIncompatibleExplicitSymbolicElement() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

class First {
}

class Second {
}

func main() {
    LiveConstraintHost.AcceptAny[First](Second())
}`
        Assert.Contains(
            BindLive(source),
            (diagnostic Diagnostic) -> diagnostic.Message.Contains(
                "Cannot convert type 'Second' to 'First'",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func LiveReflection_UserClass_WithoutParameterlessConstructor_DoesNotSatisfyNewConstraint() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

class Derived : LiveConstraintBase {
    init(value int32) {
    }
}

func main() {
    LiveConstraintHost.Accept[Derived]()
}`
        Assert.Contains(BindLive(source), (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    @Fact
    func LiveReflection_UserClass_WithPrivateParameterlessConstructor_DoesNotSatisfyNewConstraint() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

class Derived : LiveConstraintBase {
    private init() {
    }
}

func main() {
    LiveConstraintHost.Accept[Derived]()
}`
        Assert.Contains(BindLive(source), (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    @Fact
    func LiveReflection_AbstractUserClass_DoesNotSatisfyNewConstraint() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

open class Derived : LiveConstraintBase {
    open func Required();
}

func main() {
    LiveConstraintHost.Accept[Derived]()
}`
        Assert.Contains(BindLive(source), (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    @Fact
    func LiveReflection_InstanceMethodRejectsAbstractUserClassForNewConstraint() {
        const source = `package App
import GSharp.Core.Tests.CodeAnalysis.Binding

open class Derived : LiveConstraintBase {
    open func Required();
}

func main() {
    LiveConstraintReceiver().Accept[Derived]()
}`
        Assert.Contains(BindLive(source), (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    @Fact
    func UserClass_NotDerivingImportedBase_DoesNotSatisfy_GenericBaseConstraint() {
        let source = `package App
import System
import System.Reflection

class Demo {
}

func main() {
    var attr = CustomAttributeExtensions.GetCustomAttribute[Demo](typeof(int32))
}`
        Assert.Contains(Bind(source), (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    shared {
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(Array).Assembly.Location,
                typeof(Activator).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location,
                typeof(CustomAttributeExtensions).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func Bind(sources ...string) ImmutableArray[Diagnostic] {
            let trees = sources.Select(
                (source string, index int32) -> SyntaxTree.Parse(SourceText.From(source, "Test$index.gs"))
            )
                .ToImmutableArray()
            let globalScope = Binder.BindGlobalScope(previous: nil, trees, MetadataLoadContextResolver())
            let program = Binder.BindProgram(globalScope, MetadataLoadContextResolver())
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }

        private func BindLive(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            using let fixture = CSharpFixture(ContractsSource)
            using let resolver = fixture.RuntimeReferences()
            Assert.True(
                resolver.TryResolveType("GSharp.Core.Tests.CodeAnalysis.Binding.LiveConstraintBase", out var baseType)
            )
            Assert.False(baseType.IsSealed)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(globalScope, resolver)
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }

        private func EmitAndInvokeLive(source string) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            using let fixture = CSharpFixture(ContractsSource)
            using let resolver = fixture.RuntimeReferences()
            let compilation = Compilation(resolver, tree){
                AssemblyName = "GenericParamsRegression" + Guid.NewGuid().ToString("N")
            }
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            let assembly = EmittedFixture.Load(stream.ToArray(), fixture.DirectoryPath)
            let main MethodInfo? = assembly
                .GetTypes()
                .SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                }
            )
                .SingleOrDefault((method MethodInfo) -> method.Name == "main" && method.GetParameters().Length == 0)
            Assert.NotNull(main)
            main!!.Invoke(nil, nil)
        }

        private const ContractsSource string = `namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class LiveConstraintBase {}
public static class LiveConstraintHost
{
    public static void Accept<T>() where T : LiveConstraintBase, new() {}
    public static void AcceptPair<T, U>(params U[] values) where T : LiveConstraintBase, new() {}
    public static void AcceptInferred<T>(params T[] values) where T : LiveConstraintBase, new() {}
    public static void AcceptAny<T>(params T[] values) {}
    public static void AcceptStruct<T>(params T[] values) where T : struct {}
}
public sealed class LiveConstraintReceiver
{
    public void Accept<T>() where T : LiveConstraintBase, new() {}
}`
    }
}
