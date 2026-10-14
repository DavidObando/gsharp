// <copyright file="Handler322Extensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import System

/// Issue #322 fixture: an `[Extension]` method whose non-receiver parameter
/// is (cref:System.Delegate), mirroring the ASP.NET Core minimal-API
/// `MapGet(this ..., string, System.Delegate)` shape. When this assembly is
/// supplied as a reference, the binder loads the type through a
/// (cref:System.Reflection.MetadataLoadContext), so the parameter's
/// (cref:System.Delegate) type lives in a different reflection context
/// than the live runtime `Func<>` that a lambda literal carries.
/// Resolving a lambda-literal argument against this overload therefore requires
/// classifying the delegate→(cref:System.Delegate) conversion by name
/// across reflection contexts.
shared class Handler322Extensions { }

@ExtensionOwner(typeof(Handler322Extensions))
func (source string) Handle(handler Delegate) string -> source + (handler.DynamicInvoke() as string)
