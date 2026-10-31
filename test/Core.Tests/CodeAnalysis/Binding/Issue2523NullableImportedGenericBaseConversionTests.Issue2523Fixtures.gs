// <copyright file="Issue2523NullableImportedGenericBaseConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding.Issue2523Fixtures

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Linq.Expressions
import Xunit

interface IQuery2523[out TEntity] { }

interface IProjection2523[out TValue] { }

interface INested2523[out TValue] { }

interface IChain2523[out TEntity, out TProperty, in TInput, TInvariant] : IQuery2523[TEntity],
IProjection2523[TProperty],
INested2523[IProjection2523[TProperty]] { }

class MetadataEntity2523 {
    prop Child MetadataChild2523?
}

class MetadataChild2523 { }

shared class QueryExtensions2523 { }

@ExtensionOwner(typeof(QueryExtensions2523))
func (source IQuery2523[TEntity]) Include2523[TEntity, TProperty](
    selector Expression[(TEntity) -> TProperty]
) IChain2523[TEntity, TProperty, string, string] -> throw NotImplementedException()

@ExtensionOwner(typeof(QueryExtensions2523))
func (source IQuery2523[TEntity]) IncludePair2523[TEntity, TProperty](
    first Expression[(TEntity) -> TProperty],
    second Expression[(TEntity) -> TProperty]
) IChain2523[TEntity, TProperty, string, string] -> throw NotImplementedException()

@ExtensionOwner(typeof(QueryExtensions2523))
func (source IQuery2523[TEntity]) ThenInclude2523[TEntity, TPrevious, TNext](
    selector Expression[(TPrevious) -> TNext]
) IChain2523[TEntity, TNext, string, string] -> throw NotImplementedException()
