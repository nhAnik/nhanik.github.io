+++
title = 'Go: Build your own linter'
date = 2024-01-17T19:23:26+06:00
tags = ["go", "linter"]
enableComments = true

description = "Go provides rich support for lexical analysis, parsing and type checking of a go package. Using these tools, we can create our own linter to detect any issue or perform some refactoring."
+++

Go provides rich support for lexical analysis, parsing and type checking of a go package. Using
these tools, we can create our own linter to detect any issue or perform some refactoring.

To make matters easier, go [tools](https://pkg.go.dev/golang.org/x/tools) module provides
[analysis](https://pkg.go.dev/golang.org/x/tools/go/analysis) package with which we can create linter
or static analysis without manual parsing or loading packages. The [analysis](https://pkg.go.dev/golang.org/x/tools/go/analysis)
package provides a nice API to write the business logic of our linter or static analysis and test them
effectively.

### A simple linter

Let's build a simple linter that will detect a violation of the naming convention in go.
As per [documentation](https://go.dev/doc/effective_go#mixed-caps),
_The convention in Go is to use `MixedCaps` or `mixedCaps` rather than underscores to write multiword names._
So, this linter will catch usage of underscore in variable naming like _mixed_caps_.

Before diving into the code, we need to find out for which cases we will issue the warning.
We need to issue the warning where a variable is being declared. Now, a variable declaration may look like this:

```go
func _() {
    var (
        x = 10  // (1)
    )
    var y int   // (2)
    z := 10     // (3)
}
```
According to [go/ast](https://pkg.go.dev/go/ast), the variable declaration in (1) and (2) is a [DeclStmt](https://pkg.go.dev/go/ast#DeclStmt) and the short variable declaration in (3) is an [AssignStmt](https://pkg.go.dev/go/ast#AssignStmt)

What is a _DeclStmt_?
```go
// A DeclStmt node represents a declaration in a statement list.
DeclStmt struct {
    Decl Decl // *GenDecl with CONST, TYPE, or VAR token
}

// A GenDecl node (generic declaration node) represents an import,
// constant, type or variable declaration. A valid Lparen position
// (Lparen.IsValid()) indicates a parenthesized declaration.
GenDecl struct {
    Doc    *CommentGroup // associated documentation; or nil
    TokPos token.Pos     // position of Tok
    Tok    token.Token   // IMPORT, CONST, TYPE, or VAR
    Lparen token.Pos     // position of '(', if any
    Specs  []Spec
    Rparen token.Pos // position of ')', if any
}
```
A _DeclStmt_ represents a declaration and the field _Decl_ is of _Decl_ type which is an interface.
It is implemented by _*GenDecl_ and the _GenDecl_ type contains _Spec_ which is also an interface.
The _Decl_ interface is also implemented by other types like _FuncDecl_ (represents a function declaration)
which is not relevant to this case.

```go
// A ValueSpec node represents a constant or variable declaration
// (ConstSpec or VarSpec production).
ValueSpec struct {
    Doc     *CommentGroup // associated documentation; or nil
    Names   []*Ident      // value names (len(Names) > 0)
    Type    Expr          // value type; or nil
    Values  []Expr        // initial values; or nil
    Comment *CommentGroup // line comments; or nil
}
```
The interface _Spec_ is implemented by _*ValueSpec_. A _ValueSpec_ node represents a const or variable declaration and
the _Names_ field contains all the identifiers in a declaration which is of _*ast.Ident_ type.
So, for this linter, it is enough to check the identifiers in a _ValueSpec_ node.

Now, let's check what is an _AssignStmt_.
```go
// An AssignStmt node represents an assignment or
// a short variable declaration.
type AssignStmt struct {
	Lhs    []Expr
	TokPos token.Pos   // position of Tok
	Tok    token.Token // assignment token, DEFINE
	Rhs    []Expr
}
```
An _AssignStmt_ represents statement like _x = 1_ or _x := 1_.
For this linter, we are interested in _x := 1_ and check _AssignStmt_ with _Tok_ having value of _token.DEFINE_ i.e. _:=_.
Here, _DEFINE_ is a constant of type [Token](https://pkg.go.dev/go/token#Token) declared inside [go/token](https://pkg.go.dev/go/token) package.
Also, the _Lhs_ fields is a slice of _Expr_ which is an interface and it is implemented by many expression types.
We are only interested where the _Expr_ is an identifier.

So, to summarize we will check
- all the identifiers in a _ValueSpec_ node (represented by _Names_ field)
- all the left hand side identifiers in a _AssignStmt_ node (represented by _Lhs_ field where the type of the field is _*ast.Ident_)

### The code

First, we will declare a variable of type _Analyzer_. According to the documentation of [Analyzer](https://pkg.go.dev/golang.org/x/tools/go/analysis#Analyzer),

_An Analyzer statically describes an analysis function: its name, documentation, flags, relationship to other analyzers, and of course, its logic._

So, the _Analyzer_ contains some metadata of the linter and has a function that will contain the business logic.

```go
var Analyzer = &analysis.Analyzer{
	Name:     "varname",                              // (1)
	Doc:      "Check snake case variable naming",     // (2)
	Run:      run,                                    // (3)
	Requires: []*analysis.Analyzer{inspect.Analyzer}, // (4)
}

func run(pass *analysis.Pass) (interface{}, error) { // (5)
    // logic of the linter
}
```
- (1) The name of the linter is _varname_. This must not be empty and must be a valid identifier.
- (2) A helpful doc should be added. This must not be empty.
- (3) _run_ function contains the actual logic of the linter. The signature of
_Run_ field is _func(*Pass) (interface{}, error)_. So, _run_ takes an _*analysis.Pass_ as an argument and returns a result on success. If the linter returns a result the type of the result should be assigned to _ResultType_ field. So, what is the use of this result? If any other analyzer depends on this analyzer, it can use the result produced by this analyzer.
- (4) The list of analyzers that must run successfully before the linter. In this case, it is _inspect.Analyzer_. Now why do we require it as a dependency?
Because our analyzer needs to check the ASTs and the _inspect.Analyzer_ returns an [Inspector](https://pkg.go.dev/golang.org/x/tools/go/ast/inspector#Inspector). With the _Inspector_ we can do a preorder traversal on the ASTs and apply the logic of our analyzer.
- (5) _run_ will contain the business logic of the analyzer.

Now, let's write the actual logic of the analyzer.
```go
func run(pass *analysis.Pass) (interface{}, error) { // (1)
	anInspector := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector) // (2)

	nodeFilter := []ast.Node{ // (3)
		(*ast.AssignStmt)(nil),
		(*ast.ValueSpec)(nil),
	}
	anInspector.Preorder(nodeFilter, func(n ast.Node) { //(4)
		switch n := n.(type) {
		case *ast.ValueSpec: // (5)
			for _, id := range n.Names {
				if isSnakeCase(id.Name) {
					pass.ReportRangef(n, "avoid snake case naming convention")
				}
			}

		case *ast.AssignStmt: // (6)
			if n.Tok == token.DEFINE {
				for _, lhsExpr := range n.Lhs {
					if id, ok := lhsExpr.(*ast.Ident); ok && isSnakeCase(id.Name) {
						pass.ReportRangef(n, "avoid snake case naming convention")
					}
				}
			}
		}
	})

	return nil, nil
}

func isSnakeCase(s string) bool {
	return s != "_" && strings.ContainsRune(s, '_') // (7)
}
```
- (1) _pass_ which is of type [*analysis.Pass](https://pkg.go.dev/golang.org/x/tools/go/analysis#Pass) contains all the relevant information necessary for the analyzer like all the syntax trees of a package, type information, results of the prerequisite analyzers and so on. It also
provides some methods like _ReportRangef_ to generate a warning on a node. For this linter, we need the _ResultOf_ field of the _pass_
object to get the result of the prerequisite analyzer.
- (2) _pass.ResultOf_ returns the result from the required analyzer _inspect.Analyzer_ which takes all the syntax trees as argument and returns an _*inspector.Inspector_ object. The _*inspector.Inspector_ object provides some helpful methods to traverse the ASTs like _(*inspector.Inspector).Preorder_.
- (3) We decided to check the _ValueSpec_ and _AssignStmt_ node for this analyzer.
- (4) _Preorder_ runs preorder traversal for each AST and for each node of the type mentioned in _nodeFilter_ invokes the provided function.
- (5) For each _ValueSpec_, the analyzer checks whether any of the assigned identifiers has snake case naming.
- (6) For each _AssignStmt_, the analyzer checks if it is a short variable declaration and checks whether any of the assigned identifiers has snake case naming.
- (7) Here, _s != "_"_ is added to skip warning for blank identifier like _x, _ := f()_.

### Adding more functionality

Now, let's make some improvements to prevent some unwanted warnings. First, we want to prevent the analyzer from running on an auto-generated
file as the auto-generated file often contains variables with snake case and we do not want to modify it.

A generated file contains comment like this
```go
// Code generated by "stringer -type=SomeType"; DO NOT EDIT.

package foo
```
So, to check if a file is generated or not, we need to check the comments in the file.
Comments in a go file are kept under the root element of the AST which is _*ast.File_. From the [doc](https://pkg.go.dev/go/ast#File),
```go
type File struct {
	...
	Comments           []*CommentGroup // list of all comments in the source file
	GoVersion          string          // minimum Go version required by //go:build or // +build directives
}
```
So, we need to check the _Comments_ field in the _*ast.File_. But how can we get the _*ast.File_?
If we check the function in the _Preorder_ method, it just provides an _ast.Node_ and there is no parent or ancestor
information associated with it to find the root element which is the _*ast.File_ node.
```go
anInspector.Preorder(nodeFilter, func(n ast.Node) {
	// ...
})
```
Fortunately, the _*inspector.Inspector_ provides another method _WithStack_ which contains the current traversal stack
in the parameter _stack_. The first element of the _stack_ is an _*ast.File_ node.
```go
anInspector.WithStack(nodeFilter, func(n ast.Node, push bool, stack []ast.Node) (proceed bool) {
	// ...
})
```
let's modify the analyzer with the _WithStack_ method.
```go
func run(pass *analysis.Pass) (interface{}, error) {
	
	...

	anInspector.WithStack(nodeFilter, func(n ast.Node, push bool, stack []ast.Node) (proceed bool) {
		if isGeneratedFile(stack[0]) { // (1)
			return false
		}
		switch n := n.(type) {
			...
		}

		return true
	})

	return nil, nil
}

var generatedCodeRe = regexp.MustCompile(`^// Code generated .* DO NOT EDIT\.$`) // (2)

func isGeneratedFile(node ast.Node) bool {
	if file, ok := node.(*ast.File); ok {
		for _, c := range file.Comments {
			if c.Pos() >= file.Package { // (3)
				return false
			}
			for _, cc := range c.List {
				if generatedCodeRe.MatchString(cc.Text) { // (4)
					return true
				}
			}
		}
	}
	return false
}
```
- (1) For each node, check if the root element i.e. _*ast.File_ is a generated file.
- (2) A regex to match a special comment in a generated file.
- (3) Check all the comments before the _package_ keyword as the generated comments reside before _package_ keyword.
- (4) Check if the comment text is matched with the regex

We can also add a flag to the analyzer to control whether the generated file should be analyzed or not.
To do that, we will use the _Flags_ field of the _Analyzer_.

```go
var Analyzer = &analysis.Analyzer{
	Name:     "varname",
	Doc:      "Check snake case variable naming",
	Run:      run,
	Flags:    flags(), // (1)
	Requires: []*analysis.Analyzer{inspect.Analyzer},
}

var analyzeGenerated *bool

func flags() flag.FlagSet {
	var fs flag.FlagSet
	analyzeGenerated = fs.Bool("analyze-generated", false, "analyze generated file") // (2)
	return fs
}
```
- (1) _Flags_ represents all the flags defined for the analyzer
- (2) Define a flag named _analyze-generated_ having default value false.

Now, before checking if a file is generated or not we will just add an extra check whether the flag is enabled or not.
```go
if !*analyzeGenerated && isGeneratedFile(stack[0]) { // (3)
	return false
}
```

## Running the analyzer

Here is all the code for the analyzer:
```go
package varname

import (
	"flag"
	"fmt"
	"go/ast"
	"go/token"
	"regexp"
	"strings"

	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/passes/inspect"
	"golang.org/x/tools/go/ast/inspector"
)

var Analyzer = &analysis.Analyzer{
	Name:     "varname",
	Doc:      "Check snake case variable naming",
	Run:      run,
	Flags:    flags(),
	Requires: []*analysis.Analyzer{inspect.Analyzer},
}

var analyzeGenerated *bool

func flags() flag.FlagSet {
	var fs flag.FlagSet
	analyzeGenerated = fs.Bool("analyze-generated", false, "analyze generated file")
	return fs
}

func run(pass *analysis.Pass) (interface{}, error) {
	anInspector := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

	nodeFilter := []ast.Node{
		(*ast.AssignStmt)(nil),
		(*ast.ValueSpec)(nil),
	}

	anInspector.WithStack(nodeFilter, func(n ast.Node, push bool, stack []ast.Node) (proceed bool) {
		if !*analyzeGenerated && isGeneratedFile(stack[0]) {
			return false
		}
		switch n := n.(type) {
		case *ast.ValueSpec:
			for _, id := range n.Names {
				if isSnakeCase(id.Name) {
					pass.ReportRangef(n, "avoid snake case naming convention")
				}
			}

		case *ast.AssignStmt:
			if n.Tok == token.DEFINE {
				for _, lhsExpr := range n.Lhs {
					if id, ok := lhsExpr.(*ast.Ident); ok && isSnakeCase(id.Name) {
						pass.ReportRangef(n, "avoid snake case naming convention")
					}
				}
			}
		}

		return true
	})

	return nil, nil
}

var generatedCodeRe = regexp.MustCompile(`^// Code generated .* DO NOT EDIT\.$`)

func isGeneratedFile(node ast.Node) bool {
	if file, ok := node.(*ast.File); ok {
		for _, c := range file.Comments {
			if c.Pos() >= file.Package {
				return false
			}
			for _, cc := range c.List {
				if generatedCodeRe.MatchString(cc.Text) {
					return true
				}
			}
		}
	}
	return false
}

func isSnakeCase(s string) bool {
	return s != "_" && strings.ContainsRune(s, '_')
}
```
Save this code in a file in the root directory of the repository. Now, let's create the _main.go_ file inside _cmd/varname_
directory and paste:
```go
package main

import (
	"example.com/varname"
	"golang.org/x/tools/go/analysis/singlechecker"
)

func main() {
	singlechecker.Main(varname.Analyzer) // (1)
}
```
- (1) Invoke [singlechecker.Main](https://pkg.go.dev/golang.org/x/tools/go/analysis/singlechecker#Main) function and pass the _analyzer_ as an argument.

Now run `go build` inside _cmd/varname_ and we will get an executable which can be run as a CLI app. For example, we can run
```bash
varname ./...
```
inside a go project to invoke the linter.

So, what is _singlechecker.Main_ doing here?
- It performs some validation on the _Analyzer_ like checking if the _Name_ field is a valid identifier.
- It registers all the flags defined for the analyzer. Besides the defined flags, it also registers some default flags
for the analyzer. Try running _varname -h_.
- It loads all the packages (which are passed as an argument). During package loading, all the syntax trees are created and
type information is calculated and for each package, it creates the _pass_ object (remember _func run(pass *analysis.Pass)_).
So, when we run _varname ./..._ inside a go project, it loads all the packages of the project and runs the _varname_ analyzer
for each package. We can also run the analyzer on a single package like _varname fmt_ to run the analyzer on the _fmt_ package.

Also, if we have multiple analyzers, we can invoke all of them using [multichecker.Main](https://pkg.go.dev/golang.org/x/tools/go/analysis/multichecker#Main).

### Running as a CLI

Create a file with the contents given below:
```go
package main

var foo_bar string

var (
	num_of_var int
)

func _() int {
	sum_of_value := 0
	return sum_of_value
}
```
Now, run _varname ./..._ and check the output.
```text
/home/nayeem/my-codes/pg/foo.go:3:5: avoid snake case naming convention
/home/nayeem/my-codes/pg/foo.go:6:2: avoid snake case naming convention
/home/nayeem/my-codes/pg/foo.go:10:2: avoid snake case naming convention
```
Now, run the analyzer on a generated file like below:
```go
// Code generated by "stringer -type=OpType"; DO NOT EDIT.

package main

const _OpType_name = "OpAddOpSubOpMulOpDiv"

var _OpType_index = [...]uint8{0, 5, 10, 15, 20}

```
Invoking _varname_ does not give any warning on this file but we can also analyze it with the
_analyze-generated_ flag.
```bash
varname -analyze-generated .
```
Now, the warning will show up.
```text
/home/nayeem/my-codes/pg/optype_string.go:17:7: avoid snake case naming convention
/home/nayeem/my-codes/pg/optype_string.go:19:5: avoid snake case naming convention
```

### Summary
With the [analysis](https://pkg.go.dev/golang.org/x/tools/go/analysis) package, we have created a simple analyzer.
It is also possible to do the same thing without the _analysis_ package.

In that case, we have to 
- load all the packages under a go module with the appropriate config
- iterate all the ASTs in each package
- maintain the traversal stack while visiting nodes
- write the logic of the analyzer using [ast.Inspect](https://pkg.go.dev/go/ast#Inspect) or [ast.Visitor](https://pkg.go.dev/go/ast#Visitor)
- create a warning generation method
- create all the flags to run the analyzer as a CLI

With the _analysis_ package we can get rid of all the boilerplate codes and focus on only the actual logic of the
analyzer.

That's all about the analyzer.
Feel free to leave a comment below to provide feedback or share any thoughts.

Thanks for reading.
