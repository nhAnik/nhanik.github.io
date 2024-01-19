// Creates copy button in the code block
function createCopyButtons(clipboard) {
    document.querySelectorAll('pre > code').forEach(function (codeBlock) {
        var button = document.createElement('button');
        button.className = 'copy-code-button';
        button.type = 'button';
        button.innerText = 'Copy';

        button.addEventListener('click', function () {
            // The replace function is used to remove extra new lines
            // of the copied code.
            clipboard.writeText(codeBlock.innerText.replace(/\n\n/g, "\n")).then(function () {
                button.blur();
                button.innerText = 'Copied!';

                setTimeout(() => button.innerText = 'Copy', 2000);
            }, function (error) {
                button.innerText = 'Error!';
                setTimeout(() => button.innerText = 'Copy', 2000);
            });
        });

        var pre = codeBlock.parentNode;
        pre.parentNode.insertBefore(button, pre);
    });
}

if (navigator && navigator.clipboard) {
    createCopyButtons(navigator.clipboard);
} else {
    var script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/clipboard-polyfill/2.7.0/clipboard-polyfill.promise.js';
    script.integrity = 'sha512-I5JwG1CF+KVQhY79TaYrknFoPJ8pfDOVjbkQjKhiLOGIv1lhzNVKzqRR6lHl/l49mDrGnaHsUUNbQpCI4BCbAQ==';
    script.crossOrigin = 'anonymous';
    script.onload = () => createCopyButtons(clipboard);

    window.onload = () => document.body.appendChild(script);
}
