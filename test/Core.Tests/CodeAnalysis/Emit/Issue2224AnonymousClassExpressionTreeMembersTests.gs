// <copyright file="Issue2224AnonymousClassExpressionTreeMembersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2224 rubber-duck follow-up: a real runtime regression test for the
/// EF Core motivating use case — an anonymous-class literal used inside an
/// expression tree (e.g. `modelBuilder.Entity<Row>().HasKey(r =>
/// object { let Id ... = r.Id })`) must lower to a
/// (cref:NewExpression) whose (cref:NewExpression.Members) is
/// populated with the synthesized type's (cref:PropertyInfo) members
/// (not left null, and not (cref:FieldInfo)), exactly like Roslyn does
/// for a real C# anonymous type. Without this, EF Core's reflection-based
/// anonymous-shape recognition silently fails even though the expression tree
/// "looks" superficially right.
open class Issue2224AnonymousClassExpressionTreeMembersTests {
    @Fact
    func AnonymousClass_InExpressionTree_NewExpressionHasPropertyInfoMembers() {
        const Source = `package ExprAnonMembers
import System
import System.Linq.Expressions

class Row(Id int32, Alias string)

func main() object {
    let expr Expression[Func[Row, object]] = (r Row) -> object { let Id = r.Id; let Alias = r.Alias }
    return expr
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "AnonymousClass_InExpressionTree_NewExpressionHasPropertyInfoMembers"
        )
        try {
            let result object? = GetProgramMethod(asm, "main").Invoke(nil, nil)
            let lambda = Assert.IsAssignableFrom[LambdaExpression](result)
            // The lambda body boxes the struct-valued anonymous-class literal
            // to `object` (the declared Func[Row, object] return type) — unwrap
            // the Convert node to reach the underlying NewExpression.
            var body = lambda.Body
            while body is UnaryExpression unary &&
                (body.NodeType == ExpressionType.Convert || body.NodeType == ExpressionType.ConvertChecked) {
                body = unary.Operand
            }
            let newExpr = Assert.IsAssignableFrom[NewExpression](body)
            Assert.NotNull(newExpr.Members)
            Assert.Equal(2, newExpr.Members!!.Count)
            Assert.Equal("Id", newExpr.Members!![0].Name)
            Assert.Equal("Alias", newExpr.Members!![1].Name)
            Assert.All(newExpr.Members!!, (m MemberInfo) -> Assert.IsAssignableFrom[PropertyInfo](m))
            Assert.All(newExpr.Members!!, (m MemberInfo) -> Assert.IsNotAssignableFrom[FieldInfo](m))
            // The compiled delegate should still actually run end-to-end.
            let compiled = lambda.Compile()
            let rowType = asm.GetTypes().First((t Type) -> t.Name == "Row")
            let row object? = Activator.CreateInstance(rowType, 42, "hi")
            let boxed object? = compiled.DynamicInvoke(row)
            Assert.NotNull(boxed)
            let anonType = boxed!!.GetType()
            Assert.Equal(42, anonType.GetProperty("Id")!!.GetValue(boxed))
            Assert.Equal("hi", anonType.GetProperty("Alias")!!.GetValue(boxed))
        } finally {
            ctx.Unload()
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

        private func CompileToAssembly(source string, contextName string)(asm Assembly, ctx AssemblyLoadContext) {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Id + ":" + d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            let asm = loadContext.LoadFromStream(peStream)
            return (asm, loadContext)
        }
    }
}
