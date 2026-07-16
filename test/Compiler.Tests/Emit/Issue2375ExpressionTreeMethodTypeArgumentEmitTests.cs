// <copyright file="Issue2375ExpressionTreeMethodTypeArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2375 — real-assembly, IL-verification and runtime-level regression coverage. Binding alone
/// never reported an error for the reported bug (see the binder/diagnostics-level companion
/// <see cref="GSharp.Core.Tests.CodeAnalysis.Binding.Issue2375ExpressionTreeMethodTypeArgumentTests"/>);
/// the actual defect only manifested in the EMITTED assembly (ILVerify <c>StackUnexpected</c>) and, more
/// subtly, in the runtime shape of the produced <see cref="LambdaExpression"/> (whose parameter/return
/// types were the wrong same-compilation type, or <see cref="object"/>, instead of the real generic
/// method type argument). These tests emit a real two-assembly (imported library + consumer) pair to
/// disk, ILVerify the consumer, then load and invoke it to assert the runtime expression-tree shape is
/// exactly right — mirroring the real Oahu EF Core navigation-chain regression
/// (<c>HasOne(e => e.Conversion).WithOne(e => e.Book).HasForeignKey(e => e.BookId)</c>).
/// </summary>
public class Issue2375ExpressionTreeMethodTypeArgumentEmitTests
{
    [Fact]
    public void ExplicitMethodTypeArgument_IlVerifiesAndPreservesReturnType()
    {
        var (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(
            """
            package Demo
            import Lib
            import System
            import System.Linq.Expressions

            class Book { }
            class Conversion { }

            func Run(b Builder[Book]) Expression[Func[Book, Conversion]] {
                b.HasOneRequired[Conversion]((e Book) -> Conversion{})
                return b.GetLastNav[Conversion]()
            }
            """,
            nameof(ExplicitMethodTypeArgument_IlVerifiesAndPreservesReturnType));

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var (_, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName);
        try
        {
            var bookType = consumerAsm.GetTypes().Single(t => t.Name == "Book");
            var conversionType = consumerAsm.GetTypes().Single(t => t.Name == "Conversion");
            var run = GetProgramMethod(consumerAsm, "Run");

            var builderType = run.GetParameters()[0].ParameterType;
            var builder = Activator.CreateInstance(builderType);
            var capturedExpr = run.Invoke(null, new[] { builder });

            var lambda = Assert.IsAssignableFrom<LambdaExpression>(capturedExpr);
            Assert.Equal(bookType, lambda.Parameters[0].Type);
            Assert.Equal(conversionType, lambda.ReturnType);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void InferredMethodTypeArgument_IlVerifiesAndPreservesReturnType()
    {
        // No explicit [TRelated] — the method type argument is recovered purely from the deferred
        // lambda's own bound return type (defect 3 in the class-level remarks).
        var (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(
            """
            package Demo
            import Lib
            import System
            import System.Linq.Expressions

            class Book { var Conversion Conversion }
            class Conversion { }

            func Run(b Builder[Book]) Expression[Func[Book, Conversion]] {
                b.HasOne((e Book) -> e.Conversion)
                return b.GetLastNav[Conversion]()
            }
            """,
            nameof(InferredMethodTypeArgument_IlVerifiesAndPreservesReturnType));

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var (_, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName);
        try
        {
            var bookType = consumerAsm.GetTypes().Single(t => t.Name == "Book");
            var conversionType = consumerAsm.GetTypes().Single(t => t.Name == "Conversion");
            var run = GetProgramMethod(consumerAsm, "Run");

            var builderType = run.GetParameters()[0].ParameterType;
            var builder = Activator.CreateInstance(builderType);
            var capturedExpr = run.Invoke(null, new[] { builder });

            var lambda = Assert.IsAssignableFrom<LambdaExpression>(capturedExpr);

            // Defect 1's exact reported symptom: before the fix this was `Book` (the RECEIVER's own
            // TEntity), not `Conversion`.
            Assert.NotEqual(bookType, lambda.ReturnType);
            Assert.Equal(bookType, lambda.Parameters[0].Type);
            Assert.Equal(conversionType, lambda.ReturnType);

            var compiled = lambda.Compile();
            var conversionInstance = Activator.CreateInstance(conversionType);
            var bookInstance = Activator.CreateInstance(bookType);
            bookType.GetField("Conversion")!.SetValue(bookInstance, conversionInstance);
            var invoked = compiled.DynamicInvoke(bookInstance);
            Assert.Same(conversionInstance, invoked);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void NavigationChain_InferredThroughout_IlVerifiesAndRunsCorrectly()
    {
        // The exact reported Oahu EF navigation-chain shape end to end: HasOne(...).WithOne(...)
        // .HasForeignKey(...), fully inferred, real assembly, real ILVerify, real runtime invocation.
        var (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(
            """
            package Demo
            import Lib
            import System

            class Book { var Conversion Conversion }
            class Conversion {
                var BookId int32
                var Book Book
            }

            func Run(b Builder[Book]) {
                b.HasOne((e Book) -> e.Conversion)
                    .WithOne((e Conversion) -> e.Book)
                    .HasForeignKey((e Conversion) -> e.BookId)
            }
            """,
            nameof(NavigationChain_InferredThroughout_IlVerifiesAndRunsCorrectly));

        // Real ILVerify pass is the direct regression check for the reported Oahu.Data StackUnexpected
        // failure across the full navigation chain (not just a single call).
        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var (_, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName);
        try
        {
            var run = GetProgramMethod(consumerAsm, "Run");
            var builderType = run.GetParameters()[0].ParameterType;
            var builder = Activator.CreateInstance(builderType);

            // Must not throw (no invalid-cast / no unresolved-generic-token runtime failure).
            run.Invoke(null, new[] { builder });
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void DirectPlainFuncTarget_NoImportedLibrary_IlVerifiesAndRunsCorrectly()
    {
        // Defect 5 (Conversion.cs): a lambda converting directly to a PLAIN (non-Expression-wrapped)
        // constructed `Func[TEntity,TRelated]` local-variable target, with NO imported library and NO
        // generic method call involved at all. This isolates the standalone
        // `Conversion.IsFunctionShapeAssignable` / delegate-target reflection path from every
        // generic-method-substitution defect covered by the other tests in this class — single
        // assembly, real emit, real ILVerify, real runtime invocation.
        var source = """
            package Demo

            class Conversion { var Id int32 }
            class Book {
                var Id int32
                var Conversion Conversion
            }

            func Run(b Book) Conversion {
                var f Func[Book, Conversion] = (e Book) -> e.Conversion
                return f(b)
            }
            """;

        var dir = LibraryDirectory();
        var consumerPath = Path.Combine(dir, "Issue2375Emit.DirectPlainFuncTarget.dll");
        var consumerAssemblyName = "Issue2375Emit.DirectPlainFuncTarget";

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(consumerPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: consumerAssemblyName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath);

        var loadContext = new AssemblyLoadContext(consumerAssemblyName, isCollectible: true);
        try
        {
            var consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath);
            var bookType = consumerAsm.GetTypes().Single(t => t.Name == "Book");
            var conversionType = consumerAsm.GetTypes().Single(t => t.Name == "Conversion");
            var run = GetProgramMethod(consumerAsm, "Run");

            var conversionInstance = Activator.CreateInstance(conversionType);
            var bookInstance = Activator.CreateInstance(bookType);
            bookType.GetField("Conversion")!.SetValue(bookInstance, conversionInstance);

            var invoked = run.Invoke(null, new[] { bookInstance });
            Assert.Same(conversionInstance, invoked);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static MethodInfo GetProgramMethod(Assembly asm, string name)
    {
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!;
    }

    private static string LibraryDirectory()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Issue2375Emit");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string EmitSharedLibrary()
    {
        var libraryPath = Path.Combine(LibraryDirectory(), "Issue2375Emit.Library.dll");
        if (File.Exists(libraryPath))
        {
            return libraryPath;
        }

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Lib
                import System
                import System.Linq.Expressions

                class Builder[TEntity] {
                    private var lastNav object

                    func HasOneRequired[TRelated](nav Expression[Func[TEntity, TRelated]]) Builder[TRelated] {
                        lastNav = nav
                        return Builder[TRelated]{}
                    }

                    func HasOne[TRelated](nav Expression[Func[TEntity, TRelated]]) Builder[TRelated] {
                        lastNav = nav
                        return Builder[TRelated]{}
                    }

                    func WithOne[TRelated](nav Expression[Func[TEntity, TRelated]]) DependentBuilder[TRelated, TEntity] {
                        return DependentBuilder[TRelated, TEntity]{}
                    }

                    func GetLastNav[TRelated]() Expression[Func[TEntity, TRelated]] {
                        return lastNav as Expression[Func[TEntity, TRelated]]
                    }
                }

                class DependentBuilder[TPrincipal, TDependent] {
                    func HasForeignKey[TDependentEntity](fk Expression[Func[TDependentEntity, object]]) DependentBuilder[TPrincipal, TDependent] {
                        return this
                    }
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2375Emit.Library");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }

    private static (string LibraryPath, string ConsumerPath, string ConsumerAssemblyName) CompileLibraryAndConsumer(string consumerSource, string testName)
    {
        var libraryPath = EmitSharedLibrary();

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumerAssemblyName = "Issue2375Emit.Consumer." + testName;
        var consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll");

        var consumer = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(consumerSource)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(consumerPath))
        {
            var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: consumerAssemblyName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        return (libraryPath, consumerPath, consumerAssemblyName);
    }

    private static (Assembly LibraryAssembly, Assembly ConsumerAssembly, AssemblyLoadContext LoadContext) LoadLibraryAndConsumer(
        string libraryPath, string consumerPath, string consumerAssemblyName)
    {
        var loadContext = new AssemblyLoadContext(consumerAssemblyName, isCollectible: true);
        var libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath);
        loadContext.Resolving += (ctx, name) =>
            name.Name == libraryAsm.GetName().Name ? libraryAsm : null;
        var consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath);
        return (libraryAsm, consumerAsm, loadContext);
    }
}
