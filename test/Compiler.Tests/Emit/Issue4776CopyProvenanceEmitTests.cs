// <copyright file="Issue4776CopyProvenanceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using GSharp.Core.Tests;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSourceText = GSharp.Core.CodeAnalysis.Text.SourceText;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4776CopyProvenanceEmitTests
{
    [Theory]
    [InlineData("int", "42")]
    [InlineData("string", "\"payload\"")]
    public void ValueCopy_InitializesOnlyFreshValuesAndPreservesStateAndOrder(string csType, string payload)
    {
        using var native = new CSharpFixture("""
            namespace NativeCopy4776;
            public static class Trace {
                public static int Initializations;
                public static string Events = "";
                public static object Identity() { Initializations++; return new object(); }
                public static int Update(int value) { Events += value + ";"; return value; }
            }
            public record struct Value<T>(int First, int Second) {
                public object Anchor = Trace.Identity();
                private readonly object saved = new object();
                public T Payload;
                public object Hidden() => saved;
                public Value<T> Copy(int value) => this with { Second = Trace.Update(21), First = Trace.Update(value) };
            }
            """);
        var image = Compile(native.DirectoryPath, """
            package ValueCopy4776
            import NativeCopy4776
            public data struct Value[T any](First int32, Second int32) {
                public var Anchor object = Trace.Identity()
                private let Saved object = System.Object()
                public var Payload T
                public func Hidden() object -> Saved
                public func Receive() Value[T] {
                    Trace.Events = Trace.Events + "R;"
                    return this
                }
                public func Copy(value int32) Value[T] ->
                    this.Receive() with { Second = Trace.Update(21), First = Trace.Update(value) }
                public func Sugar(value int32) Value[T] ->
                    this.Receive().copy(Second: Trace.Update(21), First: Trace.Update(value))
                public func Empty() Value[T] -> this with { }
            }
            """, native.AssemblyPath);
        IlVerifier.Verify(native.AssemblyPath);
        IlVerifier.Verify(image, new[] { native.AssemblyPath });
        using var caller = new CSharpFixture($$"""
            using NativeCopy4776;
            public static class Probe {
                private static void Check(bool value, string reason) {
                    if (!value) throw new System.Exception(reason);
                }
                public static string Run() {
                    Trace.Initializations = 0;
                    var original = new ValueCopy4776.Value<{{csType}}>(7, 8) { Payload = {{payload}} };
                    var anchor = original.Anchor;
                    var operations = new System.Func<ValueCopy4776.Value<{{csType}}>> [] {
                        () => original.Copy(13), () => original.Sugar(13)
                    };
                    foreach (var operation in operations) {
                        Trace.Events = "";
                        var copy = operation();
                        Check(Trace.Initializations == 1, "copy reran declaration initializer");
                        Check(Trace.Events == "R;21;13;", "copy update order");
                        Check(copy.First == 13 && copy.Second == 21 && original.First == 7 && original.Second == 8, "copy field values");
                        Check(object.ReferenceEquals(anchor, copy.Anchor) && object.ReferenceEquals(anchor, original.Anchor), "copy identity");
                        Check(object.ReferenceEquals(original.Hidden(), copy.Hidden()), "private readonly copy identity");
                        Check(object.Equals(copy.Payload, original.Payload), "copy payload");
                    }
                    var empty = original.Empty();
                    Check(Trace.Initializations == 1 && object.ReferenceEquals(empty.Anchor, anchor), "empty copy construction");
                    Trace.Initializations = 0;
                    var native = new NativeCopy4776.Value<{{csType}}>(7, 8) { Payload = {{payload}} };
                    Trace.Events = "";
                    var nativeCopy = native.Copy(13);
                    Check(Trace.Initializations == 1 && Trace.Events == "21;13;", "native copy oracle");
                    Check(nativeCopy.First == 13 && nativeCopy.Second == 21 && native.First == 7 && native.Second == 8, "native field oracle");
                    Check(object.ReferenceEquals(native.Anchor, nativeCopy.Anchor) && object.Equals(native.Payload, nativeCopy.Payload), "native state oracle");
                    Check(object.ReferenceEquals(native.Hidden(), nativeCopy.Hidden()), "native private readonly oracle");
                    return "fresh-once|receiver-once|ordered|state";
                }
            }
            """, new[] { MetadataReference.CreateFromFile(Path.ChangeExtension(image, ".ref.dll")), MetadataReference.CreateFromFile(native.AssemblyPath) });
        IlVerifier.Verify(caller.AssemblyPath, new[] { image, native.AssemblyPath });
        var assemblies = EmittedFixture.LoadTogether(native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath), File.ReadAllBytes(image), File.ReadAllBytes(caller.AssemblyPath));
        Assert.Equal("fresh-once|receiver-once|ordered|state", assemblies[2].GetType("Probe").GetMethod("Run").Invoke(null, null));
    }

    [Theory]
    [InlineData("int", "42", false)]
    [InlineData("string", "\"payload\"", false)]
    [InlineData("int", "42", true)]
    public void ClassCopyTree_CallsVirtualTypedCloneAndPreservesLiveState(string csType, string payload, bool throughBase)
    {
        using var native = new CSharpFixture("""
            using System;
            using System.Linq.Expressions;
            namespace NativeCopy4776;
            public static class Trace {
                public static int Initializations;
                public static string Events = "";
                public static object Identity() { Initializations++; return new object(); }
                public static int Update(int value) { Events += value + ";"; return value; }
            }
            public record Root<T>(int First) {
                private readonly object anchor = Trace.Identity();
                public T Payload;
                public int State;
                public object Anchor() => anchor;
                public Root<T> Receive() { Trace.Events += "R;"; return this; }
            }
            public record Leaf<T>(int Second) : Root<T>(7);
            public static class Oracle {
                public static Expression<Func<Root<T>>> Build<T>(Root<T> original) {
                    var received = Expression.Variable(typeof(Root<T>), "received");
                    var copied = Expression.Variable(typeof(Root<T>), "copied");
                    var clone = typeof(Root<T>).GetMethod("<Clone>$", Type.EmptyTypes);
                    var update = typeof(Trace).GetMethod(nameof(Trace.Update));
                    return Expression.Lambda<Func<Root<T>>>(Expression.Block(new[] { received, copied },
                        Expression.Assign(received, Expression.Call(Expression.Constant(original), typeof(Root<T>).GetMethod("Receive"))),
                        Expression.Assign(copied, Expression.Call(received, clone)),
                        Expression.Assign(Expression.Field(copied, "State"), Expression.Call(update, Expression.Constant(21))),
                        Expression.Assign(Expression.Property(copied, "First"), Expression.Call(update, Expression.Constant(13))),
                        copied));
                }
            }
            """);
        var image = Compile(native.DirectoryPath, """
            package ClassCopyTree4776
            import System
            import System.Linq.Expressions
            import NativeCopy4776
            public open data class Root[T any](First int32) {
                private let Saved object = Trace.Identity()
                public var Payload T
                public var State int32
                public func Anchor() object -> Saved
                public func Receive() Root[T] {
                    Trace.Events = Trace.Events + "R;"
                    return this
                }
            }
            public data class Leaf[T any](Second int32) : Root[T](7) {
                public func ReceiveLeaf() Leaf[T] {
                    Trace.Events = Trace.Events + "R;"
                    return this
                }
            }
            public class Api {
                shared {
                    public func Build[T any](original Leaf[T]) Expression[Func[Leaf[T]]] ->
                        () -> original.ReceiveLeaf() with { State = Trace.Update(21), First = Trace.Update(13) }
                    public func Sugar[T any](original Leaf[T]) Expression[Func[Leaf[T]]] ->
                        () -> original.ReceiveLeaf().copy(State: Trace.Update(21), First: Trace.Update(13))
                    public func Base[T any](original Root[T]) Expression[Func[Root[T]]] ->
                        () -> original.Receive() with { State = Trace.Update(21), First = Trace.Update(13) }
                    public func Scalar() Expression[Func[int32]] -> () -> 7
                }
            }
            """, native.AssemblyPath);
        IlVerifier.Verify(native.AssemblyPath);
        IlVerifier.Verify(image, new[] { native.AssemblyPath });
        using var caller = new CSharpFixture($$"""
            using NativeCopy4776;
            using ClassCopyTree4776;
            using System.Linq.Expressions;
            public static class Probe {
                private static void Check(bool value, string reason) {
                    if (!value) throw new System.Exception(reason);
                }
                public static string Run() {
                    Trace.Initializations = 0;
                    var original = new ClassCopyTree4776.Leaf<{{csType}}>(8) { State = 31 };
                    var anchor = original.Anchor();
                    var tree = {{(throughBase ? "Api.Base(original)" : "Api.Build(original)")}};
                    Check(Trace.Initializations == 1 && Trace.Events == "", "tree construction executed copy");
                    original.State = 41;
                    original.Payload = {{payload}};
                    var run = tree.Compile();
                    for (var index = 0; index < 2; index++) {
                        Trace.Events = "";
                        var copy = run();
                        Check(copy.GetType() == original.GetType() && !object.ReferenceEquals(copy, original), "virtual clone runtime identity");
                        Check(copy.First == 13 && copy.State == 21 && ((ClassCopyTree4776.Leaf<{{csType}}>)copy).Second == 8, "clone values");
                        Check(original.First == 7 && original.State == 41 && original.Second == 8, "original state");
                        Check(object.ReferenceEquals(copy.Anchor(), anchor) && object.Equals(copy.Payload, original.Payload), "private base copy state");
                        Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;", "tree clone once and order");
                    }
                    var sugar = Api.Sugar(original).Compile();
                    Trace.Events = "";
                    var sugarCopy = sugar();
                    Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;" && object.ReferenceEquals(sugarCopy.Anchor(), anchor), "copy sugar tree");
                    Trace.Initializations = 0;
                    Trace.Events = "";
                    var native = new NativeCopy4776.Leaf<{{csType}}>(8) { Payload = {{payload}}, State = 41 };
                    var nativeTree = Oracle.Build<{{csType}}>(native);
                    Check(Trace.Initializations == 1 && Trace.Events == "", "native tree creation");
                    Trace.Events = "";
                    var nativeCopy = nativeTree.Compile()();
                    Check(nativeCopy.GetType() == native.GetType() && !object.ReferenceEquals(nativeCopy, native), "native virtual clone");
                    Check(nativeCopy.First == 13 && nativeCopy.State == 21 && ((NativeCopy4776.Leaf<{{csType}}>)nativeCopy).Second == 8, "native tree values");
                    Check(object.ReferenceEquals(nativeCopy.Anchor(), native.Anchor()) && object.Equals(nativeCopy.Payload, native.Payload), "native private state");
                    Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;" && native.State == 41, "native once and order");
                    Check(Api.Scalar().Compile()() == 7, "supported tree control");
                    return "virtual|private-base|typed|live|once|ordered";
                }
            }
            """, new[] { MetadataReference.CreateFromFile(Path.ChangeExtension(image, ".ref.dll")), MetadataReference.CreateFromFile(native.AssemblyPath) });
        IlVerifier.Verify(caller.AssemblyPath, new[] { image, native.AssemblyPath });
        var assemblies = EmittedFixture.LoadTogether(native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath), File.ReadAllBytes(image), File.ReadAllBytes(caller.AssemblyPath));
        Assert.Equal("virtual|private-base|typed|live|once|ordered", assemblies[2].GetType("Probe").GetMethod("Run").Invoke(null, null));
        var api = assemblies[1].GetType("ClassCopyTree4776.Api");
        var owner = assemblies[1].GetType("ClassCopyTree4776.Leaf`1").MakeGenericType(csType == "int" ? typeof(int) : typeof(string));
        var originalObject = Activator.CreateInstance(owner, 8);
        var method = api.GetMethod(throughBase ? "Base" : "Build").MakeGenericMethod(csType == "int" ? typeof(int) : typeof(string));
        var tree = Assert.IsAssignableFrom<LambdaExpression>(method.Invoke(null, new[] { originalObject }));
        var visitor = new CopyVisitor();
        visitor.Visit(tree.Body);
        var clone = Assert.Single(visitor.Clones);
        Assert.True(clone.Method.IsVirtual);
        Assert.Equal(tree.ReturnType, clone.Method.DeclaringType);
        Assert.Equal(tree.ReturnType, clone.Method.ReturnType);
        Assert.Empty(clone.Arguments);
        Assert.Empty(visitor.Constructions);
    }

    [Fact]
    public void ImportedClassCopyTree_KeepsExistingPreciseUnsupportedBoundary()
    {
        using var native = new CSharpFixture("namespace NativeCopy4776; public record Root<T>(T Value);");
        const string expression = "original with { }";
        var source = $$"""
            package ImportedCopyTree4776
            import System
            import System.Linq.Expressions
            import NativeCopy4776
            public func Build(original Root[int32]) Expression[Func[Root[int32]]] -> () -> {{expression}}
            """;
        using var references = native.RuntimeReferences();
        var compilation = new GsCompilation(references, GsSyntaxTree.Parse(GsSourceText.From(source))) { IsLibrary = true };
        using var image = new MemoryStream();
        var result = compilation.Emit(image, pdbStream: null, refStream: null, assemblyName: "UnsupportedCopyTree");
        Assert.False(result.Success);
        var diagnostic = Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.Id == "GS0473"));
        Assert.Equal(expression, source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length));
    }

    private static string Compile(string directory, string source, string reference)
    {
        var sourcePath = Path.Combine(directory, "Fixture.gs");
        var image = Path.Combine(directory, "Fixture.dll");
        File.WriteAllText(sourcePath, source);
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            var exit = Program.Main(new[] { "/target:library", "/targetframework:net10.0",
                "/assemblyname:Fixture", "/out:" + image, "/refout:" + Path.ChangeExtension(image, ".ref.dll"),
                "/reference:" + reference, sourcePath });
            Assert.True(exit == 0, $"gsc exited {exit}\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(File.Exists(image));
        Assert.True(File.Exists(Path.ChangeExtension(image, ".ref.dll")));
        return image;
    }

    private sealed class CopyVisitor : ExpressionVisitor
    {
        public List<MethodCallExpression> Clones { get; } = new();

        public List<NewExpression> Constructions { get; } = new();

        protected override Expression VisitMethodCall(MethodCallExpression node)
        {
            if (node.Method.Name == "<Clone>$")
            {
                Clones.Add(node);
            }

            return base.VisitMethodCall(node);
        }

        protected override Expression VisitNew(NewExpression node)
        {
            Constructions.Add(node);
            return base.VisitNew(node);
        }
    }
}
