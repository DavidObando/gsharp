// <copyright file="Issue2365ExpressionTreeGenericSubstitutionEmitTests.cs" company="GSharp">
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
/// Issue #2365 — real-assembly, IL-verification-level regression coverage. Binding alone never
/// reported an error for the reported bug (<see cref="GSharp.Core.Tests.CodeAnalysis.Binding.Issue2365ExpressionTreeGenericSubstitutionTests"/>
/// covers the binder/diagnostics surface); the actual defect only manifests in the EMITTED
/// assembly, where an imported generic method's <c>Expression&lt;Func&lt;TColumns,object&gt;&gt;</c>
/// parameter — closed over the DECLARING TYPE's own type parameter via a symbolic receiver — was
/// erased all the way down to <c>Expression&lt;Func&lt;object,object&gt;&gt;</c>, which ILVerify
/// rejects (<c>StackUnexpected</c>) and which a real runtime <see cref="LambdaExpression"/>
/// inspection reveals as <see cref="LambdaExpression.Parameters"/>[0].Type == <see cref="object"/>
/// instead of the real closed-over type. These tests emit a real two-assembly (imported
/// library + consumer) pair to disk, ILVerify the consumer, then load and invoke it to assert the
/// runtime <see cref="LambdaExpression"/> shape is exactly right.
/// </summary>
public class Issue2365ExpressionTreeGenericSubstitutionEmitTests
{
    [Fact]
    public void PrimaryKeyExpressionParameter_PreservesClosedOverClassType_IlVerifiesAndRunsCorrectly()
    {
        var (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(
            """
            package Demo
            import Lib
            import System

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) CreateTableBuilder[Cols] {
                return migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
                })
            }
            """,
            nameof(PrimaryKeyExpressionParameter_PreservesClosedOverClassType_IlVerifiesAndRunsCorrectly));

        // Real ILVerify pass is the direct regression check for the reported "Oahu.Data" 21-mismatch
        // StackUnexpected failure: before the fix, this assembly failed ILVerify with
        // "found ref 'Expression<Func<object,object>>' expected ref 'Expression<Func<Cols,object>>'".
        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var (libraryAsm, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName);
        try
        {
            var colsType = consumerAsm.GetTypes().Single(t => t.Name == "Cols");
            var migrationBuilderType = libraryAsm.GetTypes().Single(t => t.Name == "MigrationBuilder");
            var migrationBuilder = Activator.CreateInstance(migrationBuilderType);

            var run = GetProgramMethod(consumerAsm, "Run");
            var tableBuilder = run.Invoke(null, new[] { migrationBuilder });
            Assert.NotNull(tableBuilder);

            var getCapturedExpr = tableBuilder!.GetType().GetMethod("GetCapturedExpr", BindingFlags.Public | BindingFlags.Instance);
            Assert.NotNull(getCapturedExpr);
            var capturedExpr = getCapturedExpr!.Invoke(tableBuilder, null);

            var lambda = Assert.IsAssignableFrom<LambdaExpression>(capturedExpr);
            Assert.NotEqual(typeof(object), lambda.Parameters[0].Type);
            Assert.Equal(colsType, lambda.Parameters[0].Type);

            var compiled = lambda.Compile();
            var colsInstance = Activator.CreateInstance(colsType, "abc-123");
            var invoked = compiled.DynamicInvoke(colsInstance);
            Assert.Equal("abc-123", invoked);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void PrimaryKeyExpressionParameter_StructTypeArgument_IlVerifiesAndRunsCorrectly()
    {
        var (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(
            """
            package Demo
            import Lib
            import System

            data struct StructCols(Id string)

            func Run(migrationBuilder MigrationBuilder) CreateTableBuilder[StructCols] {
                return migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> StructCols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[StructCols]) -> {
                    table.PrimaryKey("PK_Accounts", (x StructCols) -> x.Id)
                })
            }
            """,
            nameof(PrimaryKeyExpressionParameter_StructTypeArgument_IlVerifiesAndRunsCorrectly));

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var (libraryAsm, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName);
        try
        {
            var structColsType = consumerAsm.GetTypes().Single(t => t.Name == "StructCols");
            var migrationBuilderType = libraryAsm.GetTypes().Single(t => t.Name == "MigrationBuilder");
            var migrationBuilder = Activator.CreateInstance(migrationBuilderType);

            var run = GetProgramMethod(consumerAsm, "Run");
            var tableBuilder = run.Invoke(null, new[] { migrationBuilder });
            Assert.NotNull(tableBuilder);

            var getCapturedExpr = tableBuilder!.GetType().GetMethod("GetCapturedExpr", BindingFlags.Public | BindingFlags.Instance);
            Assert.NotNull(getCapturedExpr);
            var capturedExpr = getCapturedExpr!.Invoke(tableBuilder, null);

            var lambda = Assert.IsAssignableFrom<LambdaExpression>(capturedExpr);
            Assert.NotEqual(typeof(object), lambda.Parameters[0].Type);
            Assert.Equal(structColsType, lambda.Parameters[0].Type);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// Issue #2224 follow-up at the runtime level: unlike the original #2224 test (a single-assembly,
    /// directly-annotated-parameter anonymous-class expression tree), this exercises the SAME kind of
    /// "class-shaped value flowing through an expression tree" guarantee (member/property shape must
    /// survive, not erase to <c>object</c>) for a class whose identity is only established via an
    /// IMPORTED generic method's symbolic receiver substitution — the #2365 code path.
    /// </summary>
    [Fact]
    public void Issue2224Followup_MultiPropertyClassThroughImportedGenericExpressionTree_PreservesMemberShape()
    {
        var (libraryPath, consumerPath, consumerAssemblyName) = CompileLibraryAndConsumer(
            """
            package Demo
            import Lib
            import System

            data class Cols(Id string, Name string)

            func Run(migrationBuilder MigrationBuilder) CreateTableBuilder[Cols] {
                return migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id"), Name: table.Column("name")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.PrimaryKey("PK_Accounts", (x Cols) -> x.Id)
                })
            }
            """,
            nameof(Issue2224Followup_MultiPropertyClassThroughImportedGenericExpressionTree_PreservesMemberShape));

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var (libraryAsm, consumerAsm, loadContext) = LoadLibraryAndConsumer(libraryPath, consumerPath, consumerAssemblyName);
        try
        {
            var colsType = consumerAsm.GetTypes().Single(t => t.Name == "Cols");
            var migrationBuilderType = libraryAsm.GetTypes().Single(t => t.Name == "MigrationBuilder");
            var migrationBuilder = Activator.CreateInstance(migrationBuilderType);

            var run = GetProgramMethod(consumerAsm, "Run");
            var tableBuilder = run.Invoke(null, new[] { migrationBuilder });
            var getCapturedExpr = tableBuilder!.GetType().GetMethod("GetCapturedExpr", BindingFlags.Public | BindingFlags.Instance);
            var capturedExpr = getCapturedExpr!.Invoke(tableBuilder, null);

            var lambda = Assert.IsAssignableFrom<LambdaExpression>(capturedExpr);
            Assert.Equal(colsType, lambda.Parameters[0].Type);

            // The body reaches a MemberExpression over the real Cols.Id property (not `object`-typed
            // reflection member access), matching the property-shape preservation goal of #2224.
            var body = lambda.Body;
            while (body is UnaryExpression unary && (body.NodeType == ExpressionType.Convert || body.NodeType == ExpressionType.ConvertChecked))
            {
                body = unary.Operand;
            }

            // `data class` primary-constructor members reify as real fields (not auto-properties);
            // either way, the member's DECLARING TYPE must be the real `Cols` type, not `object`.
            var member = Assert.IsAssignableFrom<MemberExpression>(body);
            Assert.Equal(colsType, member.Member.DeclaringType);
            Assert.Equal("Id", member.Member.Name);
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
        var dir = Path.Combine(AppContext.BaseDirectory, "Issue2365Emit");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string EmitSharedLibrary()
    {
        var libraryPath = Path.Combine(LibraryDirectory(), "Issue2365Emit.Library.dll");
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
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2365Emit.Library");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }

    private static (string LibraryPath, string ConsumerPath, string ConsumerAssemblyName) CompileLibraryAndConsumer(string consumerSource, string testName)
    {
        var libraryPath = EmitSharedLibrary();

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumerAssemblyName = "Issue2365Emit.Consumer." + testName;
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
