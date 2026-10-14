// <copyright file="Issue3149MixedDelegateExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests.Issue3149Mixed

import GSharp.Interpreter.Tests
import System
import System.Collections.Generic

/// Open generic extension candidate mixed with (cref:List{T}.Add(T)).
shared class Issue3149MixedDelegateExtensions { }

/// Must lose to the closed instance `Add` candidate.
@ExtensionOwner(typeof(Issue3149MixedDelegateExtensions))
func (callbacks List[Issue3149Greeter]) Add[T](callback(T) -> int32) {
    throw InvalidOperationException("Open generic extension candidate was selected.")
}
