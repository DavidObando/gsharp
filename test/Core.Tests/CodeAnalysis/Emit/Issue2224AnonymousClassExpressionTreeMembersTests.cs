// <copyright file="Issue2224AnonymousClassExpressionTreeMembersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2224 rubber-duck follow-up: a real runtime regression test for the
/// EF Core motivating use case — an anonymous-class literal used inside an
/// expression tree (e.g. <c>modelBuilder.Entity&lt;Row&gt;().HasKey(r =&gt;
/// object { let Id ... = r.Id })</c>) must lower to a
/// <see cref="NewExpression"/> whose <see cref="NewExpression.Members"/> is
/// populated with the synthesized type's <see cref="PropertyInfo"/> members
/// (not left null, and not <see cref="FieldInfo"/>), exactly like Roslyn does
/// for a real C# anonymous type. Without this, EF Core's reflection-based
/// anonymous-shape recognition silently fails even though the expression tree
/// "looks" superficially right.
/// </summary>
public class Issue2224AnonymousClassExpressionTreeMembersTests
{
    [Fact]
    public void AnonymousClass_InExpressionTree_NewExpressionHasPropertyInfoMembers()
    {
        const string Source = @"package ExprAnonMembers
import System
import System.Linq.Expressions

class Row(Id int32, Alias string)

func main() object {
    let expr Expression[Func[Row, object]] = (r Row) -> object { let Id int32 = r.Id, let Alias string = r.Alias }
    return expr
}
";

        var (asm, ctx) = CompileToAssembly(Source, nameof(AnonymousClass_InExpressionTree_NewExpressionHasPropertyInfoMembers));
        try
        {
            var result = GetProgramMethod(asm, "main").Invoke(null, null);
            var lambda = Assert.IsAssignableFrom<LambdaExpression>(result);

            // The lambda body boxes the struct-valued anonymous-class literal
            // to `object` (the declared Func[Row, object] return type) — unwrap
            // the Convert node to reach the underlying NewExpression.
            var body = lambda.Body;
            while (body is UnaryExpression unary && (body.NodeType == ExpressionType.Convert || body.NodeType == ExpressionType.ConvertChecked))
            {
                body = unary.Operand;
            }

            var newExpr = Assert.IsAssignableFrom<NewExpression>(body);

            Assert.NotNull(newExpr.Members);
            Assert.Equal(2, newExpr.Members.Count);
            Assert.Equal("Id", newExpr.Members[0].Name);
            Assert.Equal("Alias", newExpr.Members[1].Name);
            Assert.All(newExpr.Members, m => Assert.IsAssignableFrom<PropertyInfo>(m));
            Assert.All(newExpr.Members, m => Assert.IsNotAssignableFrom<FieldInfo>(m));

            // The compiled delegate should still actually run end-to-end.
            var compiled = lambda.Compile();
            var rowType = asm.GetTypes().First(t => t.Name == "Row");
            var row = System.Activator.CreateInstance(rowType, 42, "hi");
            var boxed = compiled.DynamicInvoke(row);
            Assert.NotNull(boxed);

            var anonType = boxed.GetType();
            Assert.Equal(42, anonType.GetProperty("Id").GetValue(boxed));
            Assert.Equal("hi", anonType.GetProperty("Alias").GetValue(boxed));
        }
        finally
        {
            ctx.Unload();
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

    private static (Assembly asm, AssemblyLoadContext ctx) CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Id + ":" + d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        var asm = loadContext.LoadFromStream(peStream);
        return (asm, loadContext);
    }
}
