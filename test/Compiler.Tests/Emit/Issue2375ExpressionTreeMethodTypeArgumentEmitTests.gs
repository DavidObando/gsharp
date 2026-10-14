// <copyright file="Issue2375ExpressionTreeMethodTypeArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2375 — real-assembly, IL-verification and runtime-level regression coverage. Binding alone
/// never reported an error for the reported bug (see the binder/diagnostics-level companion
/// (cref:GSharp.Core.Tests.CodeAnalysis.Binding.Issue2375ExpressionTreeMethodTypeArgumentTests));
/// the actual defect only manifested in the EMITTED assembly (ILVerify `StackUnexpected`) and, more
/// subtly, in the runtime shape of the produced (cref:LambdaExpression) (whose parameter/return
/// types were the wrong same-compilation type, or (cref:object), instead of the real generic
/// method type argument). These tests emit a real two-assembly (imported library + consumer) pair to
/// disk, ILVerify the consumer, then load and invoke it to assert the runtime expression-tree shape is
/// exactly right — mirroring the real Oahu EF Core navigation-chain regression
/// (`HasOne(e => e.Conversion).WithOne(e => e.Book).HasForeignKey(e => e.BookId)`).
open class Issue2375ExpressionTreeMethodTypeArgumentEmitTests {
    @Fact
    func ExplicitMethodTypeArgument_IlVerifiesAndPreservesReturnType() {
        let (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(`package Demo
import Lib
import System
import System.Linq.Expressions

class Book { }
class Conversion { }

func Run(b Builder[Book]) Expression[Func[Book, Conversion]] {
    b.HasOneRequired[Conversion]((e Book) -> Conversion{})
    return b.GetLastNav[Conversion]()
}`, "ExplicitMethodTypeArgument_IlVerifiesAndPreservesReturnType")
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let (_, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName)
        try {
            let bookType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "Book")
            let conversionType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "Conversion")
            let run = GetProgramMethod(consumerAsm, "Run")
            let builderType = run.GetParameters()[0].ParameterType
            let builder object? = Activator.CreateInstance(builderType)
            let capturedExpr object? = run.Invoke(nil, []object{builder})
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](capturedExpr)
            Assert.Equal(bookType, lambda.Parameters[0].Type)
            Assert.Equal(conversionType, lambda.ReturnType)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func InferredMethodTypeArgument_IlVerifiesAndPreservesReturnType() {
        // No explicit [TRelated] — the method type argument is recovered purely from the deferred
        // lambda's own bound return type (defect 3 in the class-level remarks).
        let (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(`package Demo
import Lib
import System
import System.Linq.Expressions

class Book { var Conversion Conversion }
class Conversion { }

func Run(b Builder[Book]) Expression[Func[Book, Conversion]] {
    b.HasOne((e Book) -> e.Conversion)
    return b.GetLastNav[Conversion]()
}`, "InferredMethodTypeArgument_IlVerifiesAndPreservesReturnType")
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let (_, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName)
        try {
            let bookType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "Book")
            let conversionType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "Conversion")
            let run = GetProgramMethod(consumerAsm, "Run")
            let builderType = run.GetParameters()[0].ParameterType
            let builder object? = Activator.CreateInstance(builderType)
            let capturedExpr object? = run.Invoke(nil, []object{builder})
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](capturedExpr)
            // Defect 1's exact reported symptom: before the fix this was `Book` (the RECEIVER's own
            // TEntity), not `Conversion`.
            Assert.NotEqual(bookType, lambda.ReturnType)
            Assert.Equal(bookType, lambda.Parameters[0].Type)
            Assert.Equal(conversionType, lambda.ReturnType)
            let compiled = lambda.Compile()
            let conversionInstance object? = Activator.CreateInstance(conversionType)
            let bookInstance object? = Activator.CreateInstance(bookType)
            bookType.GetField("Conversion")!!.SetValue(bookInstance, conversionInstance)
            let invoked object? = compiled.DynamicInvoke(bookInstance)
            Assert.Same(conversionInstance, invoked)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func NavigationChain_InferredThroughout_IlVerifiesAndRunsCorrectly() {
        // The exact reported Oahu EF navigation-chain shape end to end: HasOne(...).WithOne(...)
        // .HasForeignKey(...), fully inferred, real assembly, real ILVerify, real runtime invocation.
        let (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(`package Demo
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
}`, "NavigationChain_InferredThroughout_IlVerifiesAndRunsCorrectly")
        // Real ILVerify pass is the direct regression check for the reported Oahu.Data StackUnexpected
        // failure across the full navigation chain (not just a single call).
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let (_, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName)
        try {
            let run = GetProgramMethod(consumerAsm, "Run")
            let builderType = run.GetParameters()[0].ParameterType
            let builder object? = Activator.CreateInstance(builderType)
            // Must not throw (no invalid-cast / no unresolved-generic-token runtime failure).
            run.Invoke(nil, []object{builder})
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func DirectPlainFuncTarget_NoImportedLibrary_IlVerifiesAndRunsCorrectly() {
        // Defect 5 (Conversion.cs): a lambda converting directly to a PLAIN (non-Expression-wrapped)
        // constructed `Func[TEntity,TRelated]` local-variable target, with NO imported library and NO
        // generic method call involved at all. This isolates the standalone
        // `Conversion.IsFunctionShapeAssignable` / delegate-target reflection path from every
        // generic-method-substitution defect covered by the other tests in this class — single
        // assembly, real emit, real ILVerify, real runtime invocation.
        let source = `package Demo

class Conversion { var Id int32 }
class Book {
    var Id int32
    var Conversion Conversion
}

func Run(b Book) Conversion {
    var f Func[Book, Conversion] = (e Book) -> e.Conversion
    return f(b)
}`
        let dir = LibraryDirectory()
        let consumerPath = Path.Combine(dir, "Issue2375Emit.DirectPlainFuncTarget.dll")
        let consumerAssemblyName = "Issue2375Emit.DirectPlainFuncTarget"
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        {
            using let peStream = File.Create(consumerPath)
            let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: consumerAssemblyName)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        IlVerifier.Verify(consumerPath)
        let loadContext = AssemblyLoadContext(consumerAssemblyName, isCollectible: true)
        try {
            let consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath)
            let bookType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "Book")
            let conversionType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "Conversion")
            let run = GetProgramMethod(consumerAsm, "Run")
            let conversionInstance object? = Activator.CreateInstance(conversionType)
            let bookInstance object? = Activator.CreateInstance(bookType)
            bookType.GetField("Conversion")!!.SetValue(bookInstance, conversionInstance)
            let invoked object? = run.Invoke(nil, []object{bookInstance})
            Assert.Same(conversionInstance, invoked)
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func GetProgramMethod(asm Assembly, name string) MethodInfo {
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                name,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!
        }

        private func LibraryDirectory() string {
            let dir = Path.Combine(AppContext.BaseDirectory, "Issue2375Emit")
            Directory.CreateDirectory(dir)
            return dir
        }

        private func EmitSharedLibrary() string {
            let libraryPath = Path.Combine(LibraryDirectory(), "Issue2375Emit.Library.dll")
            if File.Exists(libraryPath) {
                return libraryPath
            }
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Lib
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
        return (lastNav as Expression[Func[TEntity, TRelated]])!!
    }
}

class DependentBuilder[TPrincipal, TDependent] {
    func HasForeignKey[TDependentEntity](fk Expression[Func[TDependentEntity, object]]) DependentBuilder[TPrincipal, TDependent] {
        return this
    }
}`))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2375Emit.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }

        private func CompileLibraryAndConsumer(consumerSource string, testName string)(
            LibraryPath string,
            ConsumerPath string,
            ConsumerAssemblyName string
        ) {
            let libraryPath = EmitSharedLibrary()
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let consumerAssemblyName = "Issue2375Emit.Consumer." + testName
            let consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll")
            let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(consumerSource))){IsLibrary = true}
            {
                using let peStream = File.Create(consumerPath)
                let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: consumerAssemblyName)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            return (libraryPath, consumerPath, consumerAssemblyName)
        }

        private func LoadLibraryAndConsumer(libraryPath string, consumerPath string, consumerAssemblyName string)(
            LibraryAssembly Assembly,
            ConsumerAssembly Assembly,
            LoadContext AssemblyLoadContext
        ) {
            let loadContext = AssemblyLoadContext(consumerAssemblyName, isCollectible: true)
            let libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath)
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if name.Name == libraryAsm
                .GetName().Name {
                libraryAsm
            } else {
                default(Assembly?)
            }
            let consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath)
            return (libraryAsm, consumerAsm, loadContext)
        }
    }
}
