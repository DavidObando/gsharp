// <copyright file="GenericMethodUserTypeArgUnderReferencesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using Binder = GSharp.Core.CodeAnalysis.Binding.Binder;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #320: imported generic methods called with an
/// explicit <em>user-defined</em> type as the type argument
/// (<c>Array.Empty[Clock]()</c>, <c>Activator.CreateInstance[Clock]()</c>,
/// <c>provider.GetService[Clock]()</c>) must resolve when references are supplied
/// explicitly (the SDK <c>/r:</c> build path), which loads them into an isolated
/// <see cref="System.Reflection.MetadataLoadContext"/>.
/// <para>
/// A user-defined type is a <see cref="StructSymbol"/> with a <c>null</c>
/// <c>ClrType</c> during binding, so the explicit type-argument resolution path
/// rejected it before ever attempting <c>MakeGenericMethod</c>, producing
/// <c>GS0159: Cannot find function</c>. The fix closes the open generic method
/// with a <c>System.Object</c> placeholder (so applicability checking succeeds)
/// while carrying the real user-type symbols to the emitter, which encodes the
/// true user-type token in the method specification.
/// </para>
/// </summary>
public class GenericMethodUserTypeArgUnderReferencesTests
{
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Array).Assembly.Location,
            typeof(System.Activator).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Linq.Enumerable).Assembly.Location,
            typeof(System.Reflection.CustomAttributeExtensions).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArray<Diagnostic> Bind(params string[] sources)
    {
        var trees = sources
            .Select((source, index) => SyntaxTree.Parse(SourceText.From(source, $"Test{index}.gs")))
            .ToImmutableArray();
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            trees,
            MetadataLoadContextResolver());
        var program = Binder.BindProgram(globalScope, MetadataLoadContextResolver());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    private static ImmutableArray<Diagnostic> BindLive(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        using var resolver = ReferenceResolver.Default();
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    private static void EmitAndInvokeLive(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        using var resolver = ReferenceResolver.Default();
        var compilation = new Compilation(resolver, tree)
        {
            AssemblyName = "GenericParamsRegression" + Guid.NewGuid().ToString("N"),
        };
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        var assembly = Assembly.Load(stream.ToArray());
        var main = assembly.GetTypes()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
            .SingleOrDefault(method => method.Name == "main" && method.GetParameters().Length == 0);
        Assert.NotNull(main);
        main.Invoke(null, null);
    }

    [Fact]
    public void Static_Generic_Method_With_UserType_Arg_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
            import System

            class Clock {
            }

            func main() {
                var arr = Array.Empty[Clock]()
                Console.WriteLine(arr.Length)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Activator_CreateInstance_With_UserType_Arg_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
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
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void BclType_Arg_Still_Resolves_Under_Explicit_References()
    {
        // Regression guard for issue #311: an all-BCL explicit type argument must
        // continue to bind exactly as before the user-type placeholder change.
        var source = """
            package App
            import System

            func main() {
                var arr = Array.Empty[string]()
                Console.WriteLine(arr.Length)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UserClass_DerivingImportedBase_Satisfies_GenericBaseConstraint()
    {
        var source = """
            package App
            import System
            import System.Reflection

            class DemoAttribute : Attribute {
            }

            func main() {
                var attr = CustomAttributeExtensions.GetCustomAttribute[DemoAttribute](typeof(int32))
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UserClass_DerivingImportedBase_InLaterFile_Satisfies_GenericBaseConstraint()
    {
        const string callSource = """
            package App
            import System
            import System.Reflection

            func main() {
                var attr = CustomAttributeExtensions.GetCustomAttribute[DemoAttribute](typeof(int32))
            }
            """;
        const string typeSource = """
            package App
            import System

            class DemoAttribute : Attribute {
            }
            """;

        Assert.Empty(Bind(callSource, typeSource));
    }

    [Fact]
    public void LiveReflection_UserClass_DerivingImportedBase_Satisfies_GenericBaseConstraint()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            class Derived : LiveConstraintBase {
            }

            func main() {
                LiveConstraintHost.Accept[Derived]()
            }
            """;

        Assert.Empty(BindLive(source));
    }

    [Fact]
    public void LiveReflection_ExpandedParams_PreservesUnconstrainedUserTypeArgument()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            class Derived : LiveConstraintBase {
            }

            class Other {
            }

            func main() {
                LiveConstraintHost.AcceptPair[Derived, Other]()
            }
            """;

        EmitAndInvokeLive(source);
    }

    [Fact]
    public void LiveReflection_InferredExpandedParams_PreservesUserElementType()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            class Derived : LiveConstraintBase {
            }

            func main() {
                LiveConstraintHost.AcceptInferred(Derived())
            }
            """;

        EmitAndInvokeLive(source);
    }

    [Fact]
    public void LiveReflection_InferredExpandedParams_WithDifferentUserTypes_UsesErasedCommonType()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            class First {
            }

            class Second {
            }

            func main() {
                LiveConstraintHost.AcceptAny(First(), Second())
            }
            """;

        EmitAndInvokeLive(source);
    }

    [Fact]
    public void LiveReflection_ExpandedParams_PreservesUserStructElementType()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            struct Item {
            }

            func main() {
                LiveConstraintHost.AcceptStruct(default(Item))
            }
            """;

        EmitAndInvokeLive(source);
    }

    [Fact]
    public void LiveReflection_ExpandedParams_ReportsIncompatibleExplicitSymbolicElement()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            class First {
            }

            class Second {
            }

            func main() {
                LiveConstraintHost.AcceptAny[First](Second())
            }
            """;

        Assert.Contains(
            BindLive(source),
            diagnostic => diagnostic.Message.Contains("Cannot convert type 'Second' to 'First'", StringComparison.Ordinal));
    }

    [Fact]
    public void LiveReflection_UserClass_WithoutParameterlessConstructor_DoesNotSatisfyNewConstraint()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            class Derived : LiveConstraintBase {
                init(value int32) {
                }
            }

            func main() {
                LiveConstraintHost.Accept[Derived]()
            }
            """;

        Assert.Contains(BindLive(source), diagnostic => diagnostic.Id == "GS0159");
    }

    [Fact]
    public void LiveReflection_UserClass_WithPrivateParameterlessConstructor_DoesNotSatisfyNewConstraint()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            class Derived : LiveConstraintBase {
                private init() {
                }
            }

            func main() {
                LiveConstraintHost.Accept[Derived]()
            }
            """;

        Assert.Contains(BindLive(source), diagnostic => diagnostic.Id == "GS0159");
    }

    [Fact]
    public void LiveReflection_AbstractUserClass_DoesNotSatisfyNewConstraint()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            open class Derived : LiveConstraintBase {
                open func Required();
            }

            func main() {
                LiveConstraintHost.Accept[Derived]()
            }
            """;

        Assert.Contains(BindLive(source), diagnostic => diagnostic.Id == "GS0159");
    }

    [Fact]
    public void LiveReflection_InstanceMethodRejectsAbstractUserClassForNewConstraint()
    {
        const string source = """
            package App
            import GSharp.Core.Tests.CodeAnalysis.Binding

            open class Derived : LiveConstraintBase {
                open func Required();
            }

            func main() {
                LiveConstraintReceiver().Accept[Derived]()
            }
            """;

        Assert.Contains(BindLive(source), diagnostic => diagnostic.Id == "GS0159");
    }

    [Fact]
    public void UserClass_NotDerivingImportedBase_DoesNotSatisfy_GenericBaseConstraint()
    {
        var source = """
            package App
            import System
            import System.Reflection

            class Demo {
            }

            func main() {
                var attr = CustomAttributeExtensions.GetCustomAttribute[Demo](typeof(int32))
            }
            """;

        Assert.Contains(Bind(source), diagnostic => diagnostic.Id == "GS0159");
    }
}

public class LiveConstraintBase
{
}

public static class LiveConstraintHost
{
    public static void Accept<T>()
        where T : LiveConstraintBase, new()
    {
    }

    public static void AcceptPair<T, U>(params U[] values)
        where T : LiveConstraintBase, new()
    {
    }

    public static void AcceptInferred<T>(params T[] values)
        where T : LiveConstraintBase, new()
    {
    }

    public static void AcceptAny<T>(params T[] values)
    {
    }

    public static void AcceptStruct<T>(params T[] values)
        where T : struct
    {
    }
}

public sealed class LiveConstraintReceiver
{
    public void Accept<T>()
        where T : LiveConstraintBase, new()
    {
    }
}
