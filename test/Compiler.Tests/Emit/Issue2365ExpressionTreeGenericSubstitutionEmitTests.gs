// <copyright file="Issue2365ExpressionTreeGenericSubstitutionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import ExpressionsUnaryExpression = System.Linq.Expressions.UnaryExpression
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

/// Issue #2365 — real-assembly, IL-verification-level regression coverage. Binding alone never
/// reported an error for the reported bug
/// ((cref:GSharp.Core.Tests.CodeAnalysis.Binding.Issue2365ExpressionTreeGenericSubstitutionTests)
/// covers the binder/diagnostics surface); the actual defect only manifests in the EMITTED
/// assembly, where an imported generic method's `Expression<Func<TColumns,object>>`
/// parameter — closed over the DECLARING TYPE's own type parameter via a symbolic receiver — was
/// erased all the way down to `Expression<Func<object,object>>`, which ILVerify
/// rejects (`StackUnexpected`) and which a real runtime (cref:LambdaExpression)
/// inspection reveals as (cref:LambdaExpression.Parameters)[0].Type == (cref:object)
/// instead of the real closed-over type. These tests emit a real two-assembly (imported
/// library + consumer) pair to disk, ILVerify the consumer, then load and invoke it to assert the
/// runtime (cref:LambdaExpression) shape is exactly right.
open class Issue2365ExpressionTreeGenericSubstitutionEmitTests {
    @Fact
    func PrimaryKeyExpressionParameter_PreservesClosedOverClassType_IlVerifiesAndRunsCorrectly() {
        let (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(`package Demo
import Lib
import System

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) CreateTableBuilder[Cols] {
    return migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
    })
}`, "PrimaryKeyExpressionParameter_PreservesClosedOverClassType_IlVerifiesAndRunsCorrectly")
        // Real ILVerify pass is the direct regression check for the reported "Oahu.Data" 21-mismatch
        // StackUnexpected failure: before the fix, this assembly failed ILVerify with
        // "found ref 'Expression<Func<object,object>>' expected ref 'Expression<Func<Cols,object>>'".
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let (libraryAsm, consumerAsm, loadContext) = LoadLibraryAndConsumer(
            libraryPath,
            consumerPath,
            consumerAssemblyName
        )
        try {
            let colsType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "Cols")
            let migrationBuilderType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "MigrationBuilder")
            let migrationBuilder object? = Activator.CreateInstance(migrationBuilderType)
            let run = GetProgramMethod(consumerAsm, "Run")
            let tableBuilder object? = run.Invoke(nil, []object{migrationBuilder})
            Assert.NotNull(tableBuilder)
            let getCapturedExpr MethodInfo? = tableBuilder!!.GetType().GetMethod(
                "GetCapturedExpr",
                BindingFlags.Public | BindingFlags.Instance
            )
            Assert.NotNull(getCapturedExpr)
            let capturedExpr object? = getCapturedExpr!!.Invoke(tableBuilder, nil)
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](capturedExpr)
            Assert.NotEqual(typeof(object), lambda.Parameters[0].Type)
            Assert.Equal(colsType, lambda.Parameters[0].Type)
            let compiled = lambda.Compile()
            let colsInstance object? = Activator.CreateInstance(colsType, "abc-123")
            let invoked object? = compiled.DynamicInvoke(colsInstance)
            Assert.Equal("abc-123", invoked)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func PrimaryKeyExpressionParameter_StructTypeArgument_IlVerifiesAndRunsCorrectly() {
        let (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(`package Demo
import Lib
import System

data struct StructCols(Id string)

func Run(migrationBuilder MigrationBuilder) CreateTableBuilder[StructCols] {
    return migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> StructCols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[StructCols]) -> {
        table.PrimaryKey("PK_Accounts", (x StructCols) -> x.Id)
    })
}`, "PrimaryKeyExpressionParameter_StructTypeArgument_IlVerifiesAndRunsCorrectly")
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let (libraryAsm, consumerAsm, loadContext) = LoadLibraryAndConsumer(
            libraryPath,
            consumerPath,
            consumerAssemblyName
        )
        try {
            let structColsType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "StructCols")
            let migrationBuilderType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "MigrationBuilder")
            let migrationBuilder object? = Activator.CreateInstance(migrationBuilderType)
            let run = GetProgramMethod(consumerAsm, "Run")
            let tableBuilder object? = run.Invoke(nil, []object{migrationBuilder})
            Assert.NotNull(tableBuilder)
            let getCapturedExpr MethodInfo? = tableBuilder!!.GetType().GetMethod(
                "GetCapturedExpr",
                BindingFlags.Public | BindingFlags.Instance
            )
            Assert.NotNull(getCapturedExpr)
            let capturedExpr object? = getCapturedExpr!!.Invoke(tableBuilder, nil)
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](capturedExpr)
            Assert.NotEqual(typeof(object), lambda.Parameters[0].Type)
            Assert.Equal(structColsType, lambda.Parameters[0].Type)
        } finally {
            loadContext.Unload()
        }
    }

    /// Issue #2224 follow-up at the runtime level: unlike the original #2224 test (a single-assembly,
    /// directly-annotated-parameter anonymous-class expression tree), this exercises the SAME kind of
    /// "class-shaped value flowing through an expression tree" guarantee (member/property shape must
    /// survive, not erase to `object`) for a class whose identity is only established via an
    /// IMPORTED generic method's symbolic receiver substitution — the #2365 code path.
    @Fact
    func Issue2224Followup_MultiPropertyClassThroughImportedGenericExpressionTree_PreservesMemberShape() {
        let (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(`package Demo
import Lib
import System

data class Cols(Id string, Name string)

func Run(migrationBuilder MigrationBuilder) CreateTableBuilder[Cols] {
    return migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id"), Name: table.Column("name")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
    })
}`, "Issue2224Followup_MultiPropertyClassThroughImportedGenericExpressionTree_PreservesMemberShape")
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let (libraryAsm, consumerAsm, loadContext) = LoadLibraryAndConsumer(
            libraryPath,
            consumerPath,
            consumerAssemblyName
        )
        try {
            let colsType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "Cols")
            let migrationBuilderType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "MigrationBuilder")
            let migrationBuilder object? = Activator.CreateInstance(migrationBuilderType)
            let run = GetProgramMethod(consumerAsm, "Run")
            let tableBuilder object? = run.Invoke(nil, []object{migrationBuilder})
            let getCapturedExpr MethodInfo? = tableBuilder!!.GetType().GetMethod(
                "GetCapturedExpr",
                BindingFlags.Public | BindingFlags.Instance
            )
            let capturedExpr object? = getCapturedExpr!!.Invoke(tableBuilder, nil)
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](capturedExpr)
            Assert.Equal(colsType, lambda.Parameters[0].Type)
            // The body reaches a MemberExpression over the real Cols.Id property (not `object`-typed
            // reflection member access), matching the property-shape preservation goal of #2224.
            var body = lambda.Body
            while body is ExpressionsUnaryExpression unary &&
                (body.NodeType == ExpressionType.Convert || body.NodeType == ExpressionType.ConvertChecked) {
                body = unary.Operand
            }
            // `data class` primary-constructor members reify as real fields (not auto-properties);
            // either way, the member's DECLARING TYPE must be the real `Cols` type, not `object`.
            let member = Assert.IsAssignableFrom[MemberExpression](body)
            Assert.Equal(colsType, member.Member.DeclaringType)
            Assert.Equal("Id", member.Member.Name)
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
            let dir = Path.Combine(AppContext.BaseDirectory, "Issue2365Emit")
            Directory.CreateDirectory(dir)
            return dir
        }

        private func EmitSharedLibrary() string {
            let libraryPath = Path.Combine(LibraryDirectory(), "Issue2365Emit.Library.dll")
            if File.Exists(libraryPath) {
                return libraryPath
            }
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Lib
import System
import System.Linq.Expressions

class ColumnsBuilder {
    func Column(name string) string { return name }
}

class CreateTableBuilder[TColumns] {
    private var capturedExpr Expression[Func[TColumns, object]]

    func PrimaryKey(name string, columns Expression[Func[TColumns, object]]) CreateTableBuilder[TColumns] {
        capturedExpr = columns
        return this
    }

    func GetCapturedExpr() Expression[Func[TColumns, object]] {
        return capturedExpr
    }
}

class MigrationBuilder {
    func CreateTable[TColumns](name string, columns Func[ColumnsBuilder, TColumns], schema string, constraints Action[CreateTableBuilder[TColumns]]) CreateTableBuilder[TColumns] {
        var builder = CreateTableBuilder[TColumns]{}
        constraints(builder)
        return builder
    }
}`))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2365Emit.Library")
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
            let consumerAssemblyName = "Issue2365Emit.Consumer." + testName
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
