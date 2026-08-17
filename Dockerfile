FROM maven:3.9-eclipse-temurin-17

# Create non-root user
RUN groupadd -g 1001 javarun && \
    useradd -u 1001 -g 1001 -m -s /bin/sh javarun && \
    mkdir -p /home/javarun/.m2 /app /tmp/javarun-classes && \
    chown -R 1001:1001 /home/javarun /app /tmp/javarun-classes

# Point Maven home to javarun's home
ENV MAVEN_CONFIG=/home/javarun/.m2
ENV HOME=/home/javarun

WORKDIR /app

USER javarun

CMD ["sh"]
