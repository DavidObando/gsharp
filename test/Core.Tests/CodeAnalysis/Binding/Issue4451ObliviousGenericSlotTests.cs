// <copyright file="Issue4451ObliviousGenericSlotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4451, ADR-0186 §4: a platform-typed argument passed to an imported
/// method's non-null reference parameter is a coercion point, so it is
/// checked at the call. Both sides of such a pair erase to one CLR type
/// (<c>string!</c> at <c>string</c>), and the imported-call argument binder
/// only converted an argument whose CLR shape differed, so the check was never
/// inserted for any imported callee. The reported shape is the worst of them:
/// an oblivious <c>List&lt;T&gt; WrapList&lt;T&gt;(T value)</c> closed as
/// <c>WrapList[string]</c> reads its parameter as <c>string</c> and its return
/// as <c>List[string]</c>, so a nil entered a non-null list and surfaced later
/// as an unattributed <see cref="NullReferenceException"/>.
/// <para>
/// A parameter the callee leaves oblivious (<c>T!</c>) or declares nullable
/// (<c>T?</c>) accepts the nil unchecked, as before.
/// </para>
/// </summary>
public class Issue4451ObliviousGenericSlotTests
{
    private const string LibrarySource = """
        namespace Issue4451.Library
        {
            using System.Collections.Generic;

            public static class Ob
            {
                public static string Nil() { return null; }

                public static string Name() { return "n"; }

                public static List<T> WrapList<T>(T value) { return new List<T> { value }; }

                public static int TakeOblivious(string value) { return value == null ? -1 : value.Length; }
            }

        #nullable enable
            public static class En
            {
                public static int TakeEnabled(string value) { return 7; }

                public static int TakeNilable(string? value) { return value == null ? -1 : value.Length; }
            }

            public sealed class Box
            {
                public Box(string value) { this.Value = value; }

                public string Value { get; }

                public int Measure(string other) { return other.Length; }
            }

            public interface ITaker
            {
                int Take(string value);
            }
        #nullable restore
        }
        """;

    private const string Prelude = """
        import Issue4451.Library
        import System
        import System.Collections.Generic

        """;

    /// <summary>
    /// The issue's repro and its siblings: each nil argument fails at the call
    /// with §4's attributed message. Before the fix none of them was checked.
    /// </summary>
    /// <param name="program">The G# statements.</param>
    [Theory]
    [InlineData("let xs = Ob.WrapList[string](Ob.Nil())\nConsole.WriteLine(xs[0].Length)")]
    [InlineData("Console.WriteLine(En.TakeEnabled(Ob.Nil()))")]
    [InlineData("let b = Box(Ob.Name())\nConsole.WriteLine(b.Measure(Ob.Nil()))")]
    [InlineData("let b = Box(Ob.Nil())\nConsole.WriteLine(b.Value.Length)")]
    [InlineData("class Taker : ITaker {\n    func Take(value string) int32 { return 7 }\n}\nfunc Via[T ITaker](x T) int32 { return x.Take(Ob.Nil()) }\nConsole.WriteLine(Via(Taker()))")]
    public void A_Nil_Platform_Argument_To_A_NonNull_Imported_Parameter_Fails_At_The_Call(string program)
    {
        using var library = new CSharpFixture(LibrarySource);

        var thrown = Assert.Throws<NullReferenceException>(() => Run(library, program));
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal);
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The check is inserted only where the parameter is non-null. An
    /// oblivious parameter and a <c>string?</c> parameter both receive the nil
    /// unchecked, and a <c>[NotNullWhen]</c> guard still narrows the bare
    /// platform variable it is handed.
    /// </summary>
    [Fact]
    public void A_Nil_Reaches_An_Oblivious_Or_Nilable_Parameter_Unchecked()
    {
        using var library = new CSharpFixture(LibrarySource);

        const string program = """
            let s = Ob.Nil()
            Console.WriteLine(Ob.TakeOblivious(s))
            Console.WriteLine(En.TakeNilable(s))
            if !String.IsNullOrEmpty(s) {
                Console.WriteLine(s.Length)
            } else {
                Console.WriteLine("empty")
            }
            let named = Ob.Name()
            Console.WriteLine(Ob.WrapList[string](named)[0])
            """;

        Assert.Equal("-1\n-1\nempty\nn\n", Run(library, program));
    }

    private static string Run(CSharpFixture library, string program)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program)))
        {
            AssemblyName = "Issue4451",
            Nullability = NullabilityMode.PlatformTypes,
        };
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: compilation.AssemblyName);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics.Select(d => $"{d.Id}: {d.Message}")));

        var libraryImage = File.ReadAllBytes(library.AssemblyPath);
        var context = new AssemblyLoadContext(nameof(Issue4451ObliviousGenericSlotTests) + Guid.NewGuid().ToString("N"), isCollectible: true);
        context.Resolving += (loadContext, name) =>
            string.Equals(name.Name, Path.GetFileNameWithoutExtension(library.AssemblyPath), StringComparison.Ordinal)
                ? loadContext.LoadFromStream(new MemoryStream(libraryImage))
                : null;
        try
        {
            pe.Position = 0;
            var assembly = context.LoadFromStream(pe);
            var entry = Assert.IsAssignableFrom<MethodInfo>(assembly.EntryPoint);
            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            catch (TargetInvocationException invocation) when (invocation.InnerException != null)
            {
                // Keep the program's own stack trace for a failing assertion.
                ExceptionDispatchInfo.Capture(invocation.InnerException).Throw();
                throw;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            context.Unload();
        }
    }
}
